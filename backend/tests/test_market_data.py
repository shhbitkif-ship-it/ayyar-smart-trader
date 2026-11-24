from datetime import datetime, timezone, timedelta
import math
from app.market_data import _normalise, _timestamp, MAX_AGE_SECONDS


def _item(updated_utc, unit="USD"):
    return {"price": 2300, "unit": unit, "updated_utc": updated_utc, "stale": False}


def test_timestamp_parses_timezone():
    assert _timestamp("2026-11-23T18:00:00+03:30").utcoffset() == timedelta(hours=3, minutes=30)


def test_timestamp_rejects_non_string_and_malformed_values():
    assert _timestamp(1763920800) is None
    assert _timestamp({"date": "today"}) is None
    assert _timestamp("not-a-timestamp") is None


def test_quote_accepts_recent_global_gold_timestamp():
    stamp = datetime.now(timezone.utc)
    q = _normalise(_item(stamp.isoformat(), "USD"), "XAUUSD", "Gold", "xau")
    assert q["status"] == "LIVE"
    assert q["price"] == 2300
    assert q["unit"] == "USD/oz"
    assert q["meta"]["unit_valid"] is True


def test_iranian_gold_uses_toman_unit():
    stamp = datetime.now(timezone.utc)
    q = _normalise(_item(stamp.isoformat(), "IRT"), "GOLD18", "Gold 18K", "gold-18k")
    assert q["status"] == "LIVE"
    assert q["unit"] == "تومان"


def test_quote_rejects_unexpected_unit_instead_of_mislabeling():
    stamp = datetime.now(timezone.utc)
    q = _normalise(_item(stamp.isoformat(), "USD"), "GOLD18", "Gold 18K", "gold-18k")
    assert q["status"] == "UNAVAILABLE"
    assert q["meta"]["unit_valid"] is False
    assert q["unit"] == "USD/oz"
    assert q["price"] is None


def test_quote_marks_data_older_than_provider_window_stale():
    stamp = datetime.now(timezone.utc) - timedelta(seconds=MAX_AGE_SECONDS + 30)
    q = _normalise(_item(stamp.isoformat()), "XAUUSD", "Gold", "xau")
    assert q["status"] == "STALE"


def test_quote_rejects_missing_timestamp():
    q = _normalise({"price": 2300, "unit": "USD"}, "XAUUSD", "Gold", "xau")
    assert q["status"] == "STALE"


def test_quote_rejects_missing_price():
    q = _normalise({"updated_utc": datetime.now(timezone.utc).isoformat(), "unit": "USD"}, "XAUUSD", "Gold", "xau")
    assert q["status"] == "UNAVAILABLE"


def test_quote_rejects_non_finite_or_boolean_prices():
    stamp = datetime.now(timezone.utc).isoformat()
    for price in (float("nan"), float("inf"), float("-inf"), True, 0, -1):
        q = _normalise({"price": price, "unit": "USD", "updated_utc": stamp}, "XAUUSD", "Gold", "xau")
        assert q["status"] == "UNAVAILABLE"
        assert q["price"] is None


def test_malformed_optional_name_does_not_break_quote_normalisation():
    item = _item(datetime.now(timezone.utc).isoformat(), "USD")
    item["name"] = "unexpected provider value"
    q = _normalise(item, "XAUUSD", "Gold", "xau")
    assert q["name"] == "Gold"
    assert q["status"] == "LIVE"


def test_provider_stale_flag_is_respected():
    item = _item(datetime.now(timezone.utc).isoformat())
    item["stale"] = True
    q = _normalise(item, "XAUUSD", "Gold", "xau")
    assert q["status"] == "STALE"


def test_duplicate_provider_ids_are_excluded_as_ambiguous():
    from app.market_data import _index_rows
    rows = [
        {"id": "xau", "price": 2300},
        {"id": "gold-18k", "price": 7000},
        {"id": "xau", "price": 2301},
        None,
        {"price": 10},
    ]
    indexed = _index_rows(rows)
    assert "xau" not in indexed
    assert indexed["gold-18k"]["price"] == 7000


def test_unique_provider_ids_are_preserved():
    from app.market_data import _index_rows
    rows = [{"id": "xau", "price": 2300}, {"id": "usd", "price": 70000}]
    assert set(_index_rows(rows)) == {"xau", "usd"}


def test_snapshot_status_distinguishes_partial_from_full_availability(monkeypatch):
    import asyncio
    import app.market_data as market_data

    async def fake_provider():
        now = datetime.now(timezone.utc).isoformat()
        return {"generated_utc": now, "items": [{"id": "xau", "price": 2300, "unit": "USD", "updated_utc": now, "stale": False}]}

    monkeypatch.setattr(market_data, "_fetch_provider_json", fake_provider)
    monkeypatch.setattr(market_data, "_cache", None)
    result = asyncio.run(market_data.market_snapshot())
    assert result["status"] == "PARTIAL"
    assert sum(q["status"] == "LIVE" for q in result["quotes"]) == 1


def test_snapshot_marks_no_live_quotes_unavailable(monkeypatch):
    import asyncio
    import app.market_data as market_data

    async def fake_provider():
        return {"generated_utc": None, "items": []}

    monkeypatch.setattr(market_data, "_fetch_provider_json", fake_provider)
    monkeypatch.setattr(market_data, "_cache", None)
    result = asyncio.run(market_data.market_snapshot())
    assert result["status"] == "UNAVAILABLE"

def test_snapshot_rejects_quotes_when_provider_timestamp_is_missing(monkeypatch):
    import asyncio
    import app.market_data as market_data
    async def fake_provider():
        now = datetime.now(timezone.utc).isoformat()
        return {"items": [{"id": "xau", "price": 2300, "unit": "USD", "updated_utc": now, "stale": False}]}
    monkeypatch.setattr(market_data, "_fetch_provider_json", fake_provider)
    monkeypatch.setattr(market_data, "_cache", None)
    result = asyncio.run(market_data.market_snapshot())
    xau = next(q for q in result["quotes"] if q["symbol"] == "XAUUSD")
    assert xau["status"] == "STALE"
    assert result["status"] == "UNAVAILABLE"

def test_snapshot_rejects_quotes_when_provider_timestamp_is_old(monkeypatch):
    import asyncio
    import app.market_data as market_data
    async def fake_provider():
        now = datetime.now(timezone.utc)
        old = (now - timedelta(seconds=MAX_AGE_SECONDS + 60)).isoformat()
        return {"generated_utc": old, "items": [{"id": "xau", "price": 2300, "unit": "USD", "updated_utc": now.isoformat(), "stale": False}]}
    monkeypatch.setattr(market_data, "_fetch_provider_json", fake_provider)
    monkeypatch.setattr(market_data, "_cache", None)
    result = asyncio.run(market_data.market_snapshot())
    xau = next(q for q in result["quotes"] if q["symbol"] == "XAUUSD")
    assert xau["status"] == "STALE"

def test_provider_failure_is_not_cached_and_next_request_recovers(monkeypatch):
    import asyncio
    import app.market_data as market_data
    calls = {"count": 0}
    async def flaky_provider():
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("temporary outage")
        now = datetime.now(timezone.utc).isoformat()
        return {"generated_utc": now, "items": [{"id": "xau", "price": 2300, "unit": "USD", "updated_utc": now, "stale": False}]}
    monkeypatch.setattr(market_data, "_fetch_provider_json", flaky_provider)
    monkeypatch.setattr(market_data, "_cache", None)
    first = asyncio.run(market_data.market_snapshot())
    second = asyncio.run(market_data.market_snapshot())
    assert first["status"] == "UNAVAILABLE"
    assert second["status"] == "PARTIAL"
    assert calls["count"] == 2

def test_cached_snapshot_expires_at_quote_freshness_limit():
    from app.market_data import _refresh_snapshot_status
    now = datetime.now(timezone.utc)
    stamp = now - timedelta(seconds=MAX_AGE_SECONDS - 2)
    quote = _normalise({"price": 2300, "unit": "USD", "updated_utc": stamp.isoformat(), "stale": False}, "XAUUSD", "Gold", "xau")
    snapshot = {"status": "LIVE", "provider_generated_at": now, "quotes": [quote]}
    refreshed = _refresh_snapshot_status(snapshot, now + timedelta(seconds=5))
    assert refreshed["quotes"][0]["status"] == "STALE"
    assert refreshed["status"] == "UNAVAILABLE"
