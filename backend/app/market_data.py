"""Keyless Iranian and global gold quotes from NerkhAra's public JSON feed.

NerkhAra refreshes its source snapshot every ten minutes. Prices are indicative
market readings, not executable broker quotes. We preserve source timestamps,
stale flags, source count and spread metadata.
"""
from __future__ import annotations
import math
import time
from datetime import datetime, timezone, timedelta
import httpx

SOURCE_URL = "https://nerkhara.com/api/v1/latest.json"
CACHE_SECONDS = 60
MAX_AGE_SECONDS = 660
MAX_SINGLE_SNAPSHOT_MOVE_PCT = 5.0
PRICE_JUMP_CONFIRMATION_TOLERANCE_PCT = 1.0
_accepted_prices: dict[str, float] = {}
_pending_price_jumps: dict[str, float] = {}


def _index_rows(rows: list) -> dict:
    """Index provider rows while excluding duplicate IDs as ambiguous input."""
    indexed = {}
    duplicates = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        source_id = row.get("id")
        if not isinstance(source_id, str) or not source_id:
            continue
        if source_id in indexed:
            duplicates.add(source_id)
        else:
            indexed[source_id] = row
    for source_id in duplicates:
        indexed.pop(source_id, None)
    return indexed

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


def _optional_finite_number(value, *, minimum: float | None = None):
    """Return a safe numeric metadata value, or None for malformed provider data."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if minimum is not None and value < minimum:
        return None
    return value


def _optional_source_count(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _display_name(value, fallback: str) -> str:
    if not isinstance(value, dict):
        return fallback
    for key in ("fa", "en"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()[:80]
    return fallback


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
    display_name = _display_name(item.get("name"), name)
    change_pct = _optional_finite_number(item.get("change_pct"))
    spread_pct = _optional_finite_number(item.get("spread_pct"), minimum=0)
    sources = _optional_source_count(item.get("sources"))
    method = item.get("method")
    if not isinstance(method, str):
        method = None
    meta = {
        "provider_id": source_id,
        "source_unit": source_unit,
        "unit_valid": unit_valid,
        "updated_utc": item.get("updated_utc"),
        "change_pct": change_pct,
        "sources": sources,
        "spread_pct": spread_pct,
        "method": method[:80] if method else None,
        "stale": stale_flag,
        "reason": None if valid and unit_valid else "Symbol is missing, price is invalid, or its unit does not match the expected market unit",
    }
    return {
        # Expose a numeric quote only when timestamp and unit are verified LIVE.
        "symbol": symbol, "name": display_name, "price": price if status == "LIVE" else None,
        "unit": unit, "source": "NerkhAra", "timestamp": stamp,
        "age_seconds": round(age, 1) if age is not None else None,
        "status": status, "meta": meta,
    }


def _quarantine_price_jumps(snapshot: dict, previous: dict | None = None) -> dict:
    """Quarantine a large one-snapshot move; accept it only after a second confirmation."""
    result = dict(snapshot)
    refreshed = []
    for original in result.get("quotes", []):
        quote = dict(original)
        symbol = quote.get("symbol")
        price = quote.get("price")
        valid = (
            isinstance(symbol, str)
            and quote.get("status") == "LIVE"
            and isinstance(price, (int, float)) and not isinstance(price, bool)
            and math.isfinite(price) and price > 0
        )
        if not valid:
            refreshed.append(quote)
            continue

        prior_price = _accepted_prices.get(symbol)
        if prior_price is None:
            _accepted_prices[symbol] = float(price)
            _pending_price_jumps.pop(symbol, None)
            refreshed.append(quote)
            continue

        move_pct = abs((price / prior_price - 1) * 100)
        if move_pct > MAX_SINGLE_SNAPSHOT_MOVE_PCT:
            pending_price = _pending_price_jumps.get(symbol)
            confirmed = (
                isinstance(pending_price, (int, float))
                and pending_price > 0
                and abs((price / pending_price - 1) * 100) <= PRICE_JUMP_CONFIRMATION_TOLERANCE_PCT
            )
            if confirmed:
                _accepted_prices[symbol] = float(price)
                _pending_price_jumps.pop(symbol, None)
                meta = dict(quote.get("meta") or {})
                meta["price_jump_pct"] = round(move_pct, 2)
                meta["price_jump_confirmed"] = True
                quote["meta"] = meta
            else:
                _pending_price_jumps[symbol] = float(price)
                quote["price"] = None
                quote["status"] = "STALE"
                quote["meta"] = {
                    **(quote.get("meta") or {}),
                    "reason": (
                        f"Price jump of {move_pct:.2f}% exceeds the "
                        f"{MAX_SINGLE_SNAPSHOT_MOVE_PCT:.1f}% review threshold; "
                        "waiting for a confirming provider snapshot"
                    ),
                    "price_jump_pct": round(move_pct, 2),
                    "price_jump_confirmed": False,
                }
        else:
            _accepted_prices[symbol] = float(price)
            _pending_price_jumps.pop(symbol, None)
        refreshed.append(quote)

    result["quotes"] = refreshed
    live = sum(1 for quote in refreshed if quote.get("status") == "LIVE")
    result["status"] = "LIVE" if refreshed and live == len(refreshed) else "PARTIAL" if live else "UNAVAILABLE"
    return result


def _refresh_snapshot_status(snapshot: dict, now: datetime | None = None) -> dict:
    """Re-evaluate provider and quote freshness, including cached snapshots."""
    now = now or datetime.now(timezone.utc)
    result = dict(snapshot)
    generated = result.get("provider_generated_at")
    generated_age = (now - generated.astimezone(timezone.utc)).total_seconds() if isinstance(generated, datetime) else None
    generated_valid = generated_age is not None and -30 <= generated_age <= MAX_AGE_SECONDS
    refreshed = []
    for original in result.get("quotes", []):
        quote = dict(original)
        meta = dict(quote.get("meta") or {})
        stamp = quote.get("timestamp")
        age = (now - stamp.astimezone(timezone.utc)).total_seconds() if isinstance(stamp, datetime) else None
        price = quote.get("price")
        price_valid = isinstance(price, (int, float)) and not isinstance(price, bool) and math.isfinite(price) and price > 0
        quote_after_snapshot = (
            isinstance(generated, datetime)
            and isinstance(stamp, datetime)
            and stamp.astimezone(timezone.utc) > generated.astimezone(timezone.utc)
                + timedelta(seconds=30)
        )
        if not price_valid or meta.get("unit_valid") is not True:
            quote["status"] = "UNAVAILABLE"
        elif (
            not generated_valid
            or age is None
            or not -30 <= age <= MAX_AGE_SECONDS
            or meta.get("stale") is True
            or quote_after_snapshot
        ):
            quote["status"] = "STALE"
        else:
            quote["status"] = "LIVE"
        quote["age_seconds"] = round(age, 1) if age is not None else None
        # Revalidate cached quotes on every request and hide stale numeric values.
        if quote["status"] != "LIVE":
            quote["price"] = None
        if not generated_valid and price_valid and meta.get("unit_valid") is True:
            meta["reason"] = "Provider snapshot timestamp is missing, malformed, future-dated, or stale"
        elif quote_after_snapshot:
            meta["reason"] = "Quote timestamp is materially newer than the provider snapshot"
        quote["meta"] = meta
        refreshed.append(quote)
    result["quotes"] = refreshed
    live = sum(1 for quote in refreshed if quote["status"] == "LIVE")
    result["status"] = "LIVE" if refreshed and live == len(refreshed) else "PARTIAL" if live else "UNAVAILABLE"
    return result

async def market_snapshot() -> dict:
    global _cache, _cache_at
    now_mono = time.monotonic()
    if _cache is not None and now_mono - _cache_at < CACHE_SECONDS:
        return _refresh_snapshot_status(_cache)
    try:
        payload = await _fetch_provider_json()
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            raise ValueError("Unexpected NerkhAra response schema: expected an items array")
        rows = payload["items"]
        by_id = _index_rows(rows)
        quotes = [_normalise(by_id.get(source_id), symbol, name, source_id)
                  for symbol, name, source_id in SYMBOLS]
        live = sum(1 for quote in quotes if quote["status"] == "LIVE")
        snapshot_status = "LIVE" if live == len(quotes) else "PARTIAL" if live else "UNAVAILABLE"
        result = {
            "status": snapshot_status,
            "as_of": datetime.now(timezone.utc),
            "provider_generated_at": _timestamp(payload.get("generated_utc")),
            "quotes": quotes,
            "notice": "NerkhAra is refreshed every ten minutes. These are indicative market readings, not broker execution quotes. STALE or UNAVAILABLE prices must never generate trade signals.",
            "attribution": "NerkhAra — https://nerkhara.com",
        }
        result = _refresh_snapshot_status(result)
        previous_snapshot = _cache if isinstance(_cache, dict) else None
        result = _quarantine_price_jumps(result, previous_snapshot)

        # Never replace a newer accepted provider snapshot with an older one.
        # A provider clock/data rollback must fail closed rather than revive old quotes.
        previous_generated = _cache.get("provider_generated_at") if isinstance(_cache, dict) else None
        incoming_generated = result.get("provider_generated_at")
        if (
            isinstance(previous_generated, datetime)
            and isinstance(incoming_generated, datetime)
            and incoming_generated.astimezone(timezone.utc) < previous_generated.astimezone(timezone.utc)
        ):
            result = {
                "status": "UNAVAILABLE",
                "as_of": datetime.now(timezone.utc),
                "provider_generated_at": incoming_generated,
                "quotes": [
                    {**quote, "price": None, "status": "STALE",
                     "meta": {**(quote.get("meta") or {}), "reason": "Provider snapshot timestamp moved backwards"}}
                    for quote in result.get("quotes", [])
                ],
                "notice": "Provider snapshot moved backwards in time. Quotes are withheld until the source recovers.",
                "error": "ProviderSnapshotRollback",
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
    if result.get("status") != "UNAVAILABLE":
        _cache, _cache_at = result, now_mono
    else:
        _cache, _cache_at = None, 0.0
    return result
