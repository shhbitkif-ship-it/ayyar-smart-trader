"""Keyless Iranian and global gold quotes from NerkhAra's public JSON feed.

NerkhAra refreshes its source snapshot every ten minutes. Prices are indicative
market readings, not executable broker quotes. We preserve source timestamps,
stale flags, source count and spread metadata.
"""
from __future__ import annotations
import time
from datetime import datetime, timezone
import httpx

SOURCE_URL = "https://nerkhara.com/api/v1/latest.json"
CACHE_SECONDS = 60
MAX_AGE_SECONDS = 660

SYMBOLS = [
    ("GOLD18", "طلای ۱۸ عیار", "gold-18k"),
    ("GOLD24", "طلای ۲۴ عیار", "gold-24k"),
    ("MESGHAL", "مظنه آبشده", "gold-mesghal"),
    ("COIN_EMAMI", "سکه امامی", "coin-emami"),
    ("COIN_HALF", "نیم سکه", "coin-half"),
    ("COIN_QUARTER", "ربع سکه", "coin-quarter"),
    ("USD_IRT", "دلار بازار آزاد", "usd"),
    ("XAUUSD", "اونس جهانی طلا", "xau"),
]

_cache: dict | None = None
_cache_at = 0.0


def _timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (TypeError, ValueError):
        return None


async def _fetch_provider_json() -> dict:
    # Pyodide's fetch bridge is the supported outbound HTTP path on Workers.
    try:
        from pyodide.http import pyfetch
    except ImportError:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            response = await client.get(SOURCE_URL, headers={"Accept": "application/json"})
            response.raise_for_status()
            return response.json()
    response = await pyfetch(SOURCE_URL, method="GET", headers={"Accept": "application/json"})
    if not response.ok:
        raise RuntimeError(f"NerkhAra HTTP {response.status}")
    return await response.json()


def _normalise(item: dict | None, symbol: str, name: str, source_id: str) -> dict:
    item = item or {}
    price = item.get("price")
    stamp = _timestamp(item.get("updated_utc"))
    now = datetime.now(timezone.utc)
    valid = isinstance(price, (int, float)) and not isinstance(price, bool) and price > 0
    age = (now - stamp.astimezone(timezone.utc)).total_seconds() if stamp else None
    stale_flag = item.get("stale") is True
    status = "LIVE" if valid and stamp and not stale_flag and -30 <= age <= MAX_AGE_SECONDS else "STALE" if valid else "UNAVAILABLE"
    unit = "USD/oz" if item.get("unit") == "USD" else "تومان"
    name_data = item.get("name") or {}
    display_name = name_data.get("fa") or name_data.get("en") or name
    meta = {
        "provider_id": source_id,
        "change_pct": item.get("change_pct"),
        "sources": item.get("sources"),
        "spread_pct": item.get("spread_pct"),
        "method": item.get("method"),
        "stale": stale_flag,
        "reason": None if valid else "Symbol is missing from the public provider feed",
    }
    return {
        "symbol": symbol, "name": display_name, "price": price if valid else None,
        "unit": unit, "source": "NerkhAra", "timestamp": stamp,
        "age_seconds": round(age, 1) if age is not None else None,
        "status": status, "meta": meta,
    }


async def market_snapshot() -> dict:
    global _cache, _cache_at
    now_mono = time.monotonic()
    if _cache is not None and now_mono - _cache_at < CACHE_SECONDS:
        return _cache
    try:
        payload = await _fetch_provider_json()
        rows = payload.get("items") or []
        by_id = {row.get("id"): row for row in rows if isinstance(row, dict)}
        quotes = [_normalise(by_id.get(source_id), symbol, name, source_id)
                  for symbol, name, source_id in SYMBOLS]
        live = sum(1 for quote in quotes if quote["status"] == "LIVE")
        result = {
            "status": "LIVE" if live else "UNAVAILABLE",
            "as_of": datetime.now(timezone.utc),
            "provider_generated_at": _timestamp(payload.get("generated_utc")),
            "quotes": quotes,
            "notice": "NerkhAra is refreshed every ten minutes. These are indicative market readings, not broker execution quotes. STALE or UNAVAILABLE prices must never generate trade signals.",
            "attribution": "NerkhAra — https://nerkhara.com",
        }
    except Exception as exc:
        result = {
            "status": "UNAVAILABLE",
            "as_of": datetime.now(timezone.utc),
            "provider_generated_at": None,
            "quotes": [_normalise(None, symbol, name, source_id)
                       for symbol, name, source_id in SYMBOLS],
            "notice": "The public market-data provider is unavailable. No synthetic prices are shown.",
            "error": type(exc).__name__,
            "attribution": "NerkhAra — https://nerkhara.com",
        }
    _cache, _cache_at = result, now_mono
    return result
