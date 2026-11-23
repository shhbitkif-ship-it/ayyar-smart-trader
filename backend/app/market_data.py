"""Async provider adapters compatible with standard Python and Cloudflare Workers."""
from __future__ import annotations
import os
from datetime import datetime, timezone
from typing import Any
import httpx

IRAN_BASE = "https://talasanj.info/api/v1"
GLOBAL_BASE = "https://api.metals.dev/v1"


def _secret(name: str, env: Any = None) -> str | None:
    """Read a Cloudflare binding first, then process env for local development."""
    if env is not None:
        try:
            value = env.get(name) if isinstance(env, dict) else getattr(env, name, None)
            if value:
                return str(value)
        except Exception:
            pass
    return os.getenv(name)


def _timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (TypeError, ValueError):
        return None


def _quote(symbol: str, name: str, price: Any, unit: str, source: str,
           stamp: datetime | None, extra: dict | None = None) -> dict:
    now = datetime.now(timezone.utc)
    valid_number = isinstance(price, (int, float)) and not isinstance(price, bool) and price > 0
    age = (now - stamp.astimezone(timezone.utc)).total_seconds() if stamp else None
    status = "LIVE" if valid_number and age is not None and -30 <= age <= 90 else "STALE" if valid_number else "UNAVAILABLE"
    return {
        "symbol": symbol, "name": name, "price": price if valid_number else None,
        "unit": unit, "source": source, "timestamp": stamp,
        "age_seconds": round(age, 1) if age is not None else None,
        "status": status, "meta": extra or {},
    }


async def get_iran_quotes(env: Any = None) -> list[dict]:
    key = _secret("TALASANJ_KEY", env)
    if not key:
        return [_quote("IRAN_PROVIDER", "Iran market data", None, "", "Talasanj", None,
                       {"reason": "TALASANJ_KEY is not configured"})]
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(
                f"{IRAN_BASE}/prices",
                headers={"Authorization": f"Bearer {key}", "X-Client-Name": "Ayyar Smart Trader"},
            )
            response.raise_for_status()
            payload = response.json()
        stamp = _timestamp(payload.get("updated_at"))
        prices = payload.get("prices") or {}
        mapping = [
            ("GOLD18", "طلای ۱۸ عیار", "gram18"), ("GOLD24", "طلای ۲۴ عیار", "gram24"),
            ("MESGHAL", "مظنه آبشده", "mazaneh"), ("COIN_EMAMI", "سکه امامی", "coin_full"),
            ("COIN_HALF", "نیم سکه", "coin_half"), ("COIN_QUARTER", "ربع سکه", "coin_quarter"),
            ("USD_IRT", "دلار تهران", "usd"), ("XAUUSD", "اونس جهانی طلا", "ounce"),
        ]
        out = []
        for symbol, name, key_name in mapping:
            row = prices.get(key_name) or {}
            unit = "USD/oz" if key_name == "ounce" else "Toman"
            out.append(_quote(symbol, name, row.get("price"), unit, "Talasanj", stamp,
                              {k: v for k, v in row.items() if k != "price"}))
        return out
    except Exception as exc:
        return [_quote("IRAN_PROVIDER", "Iran market data", None, "", "Talasanj", None,
                       {"reason": type(exc).__name__})]


async def get_global_quote(env: Any = None) -> dict:
    key = _secret("METALS_DEV_KEY", env)
    if not key:
        return _quote("XAUUSD", "Gold spot", None, "USD/oz", "Metals.Dev", None,
                      {"reason": "METALS_DEV_KEY is not configured"})
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(
                f"{GLOBAL_BASE}/metal/spot",
                params={"api_key": key, "metal": "gold", "currency": "USD"},
                headers={"Accept": "application/json"},
            )
            response.raise_for_status()
            payload = response.json()
        rate = payload.get("rate") or {}
        return _quote("XAUUSD", "Gold spot", rate.get("price"), "USD/oz", "Metals.Dev",
                      _timestamp(payload.get("timestamp")),
                      {k: v for k, v in rate.items() if k != "price"})
    except Exception as exc:
        return _quote("XAUUSD", "Gold spot", None, "USD/oz", "Metals.Dev", None,
                      {"reason": type(exc).__name__})


async def market_snapshot(env: Any = None) -> dict:
    global_quote, iran = await __import__("asyncio").gather(get_global_quote(env), get_iran_quotes(env))
    iran_global = next((q for q in iran if q["symbol"] == "XAUUSD"), None)
    if global_quote["status"] != "LIVE" and iran_global and iran_global["status"] == "LIVE":
        global_quote = {
            **iran_global, "source": "Talasanj (fallback)",
            "meta": {**iran_global["meta"], "fallback_for": "Metals.Dev"},
        }
    quotes = [global_quote] + [q for q in iran if q["symbol"] not in ("IRAN_PROVIDER", "XAUUSD")]
    return {
        "status": "LIVE" if any(q["status"] == "LIVE" for q in quotes) else "UNAVAILABLE",
        "as_of": datetime.now(timezone.utc), "quotes": quotes,
        "notice": "A quote marked STALE or UNAVAILABLE must never be used to generate a trade signal.",
    }
