"""Keyless Iranian and global gold quotes from NerkhAra's public JSON feed.

NerkhAra refreshes its source snapshot every ten minutes. Prices are indicative
market readings, not executable broker quotes. We preserve source timestamps,
stale flags, source count and spread metadata.
"""
from __future__ import annotations
import math
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
    # Provider fields are external input: reject non-strings without raising.
    if not isinstance(value, str) or not value:
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
    item = item if isinstance(item, dict) else {}
    price = item.get("price")
    valid = (
        isinstance(price, (int, float))
        and not isinstance(price, bool)
        and math.isfinite(price)
        and price > 0
    )
    stamp = _timestamp(item.get("updated_utc"))
    now = datetime.now(timezone.utc)
    age = (now - stamp.astimezone(timezone.utc)).total_seconds() if stamp else None
    stale_flag = item.get("stale") is True
    status = (
        "LIVE" if valid and stamp and not stale_flag and -30 <= age <= MAX_AGE_SECONDS
        else "STALE" if valid
        else "UNAVAILABLE"
    )
    source_unit = item.get("unit")
    expected_unit = "USD" if source_id == "xau" else "IRT"
    unit_valid = source_unit == expected_unit
    if not unit_valid:
        status = "UNAVAILABLE"
    unit = "USD/oz" if source_unit == "USD" else "تومان" if source_unit == "IRT" else "نامشخص"
    name_data = item.get("name")
    if isinstance(name_data, dict):
        display_name = name_data.get("fa") or name_data.get("en") or name
    else:
        display_name = name
    meta = {
        "provider_id": source_id,
        "source_unit": source_unit,
        "unit_valid": unit_valid,
        "updated_utc": item.get("updated_utc"),
        "change_pct": item.get("change_pct"),
        "sources": item.get("sources"),
        "spread_pct": item.get("spread_pct"),
        "method": item.get("method"),
        "stale": stale_flag,
        "reason": None if valid and unit_valid else "Symbol is missing, price is invalid, or its unit does not match the expected market unit",
    }
    return {
        "symbol": symbol, "name": display_name, "price": price if valid and unit_valid else None,
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
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            raise ValueError("Unexpected NerkhAra response schema: expected an items array")
        rows = payload["items"]
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
