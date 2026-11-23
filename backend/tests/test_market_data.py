from datetime import datetime, timezone, timedelta
from app.market_data import _normalise, _timestamp, MAX_AGE_SECONDS


def _item(updated_utc):
    return {"price": 2300, "unit": "USD", "updated_utc": updated_utc, "stale": False}


def test_timestamp_parses_timezone():
    assert _timestamp("2026-11-23T18:00:00+03:30").utcoffset() == timedelta(hours=3, minutes=30)


def test_quote_accepts_recent_timestamp():
    stamp = datetime.now(timezone.utc)
    q = _normalise(_item(stamp.isoformat()), "XAUUSD", "Gold", "xau")
    assert q["status"] == "LIVE"
    assert q["price"] == 2300


def test_quote_marks_data_older_than_provider_window_stale():
    stamp = datetime.now(timezone.utc) - timedelta(seconds=MAX_AGE_SECONDS + 30)
    q = _normalise(_item(stamp.isoformat()), "XAUUSD", "Gold", "xau")
    assert q["status"] == "STALE"


def test_quote_rejects_missing_timestamp():
    q = _normalise({"price": 2300, "unit": "USD"}, "XAUUSD", "Gold", "xau")
    assert q["status"] == "STALE"


def test_quote_rejects_missing_price():
    q = _normalise({"updated_utc": datetime.now(timezone.utc).isoformat()}, "XAUUSD", "Gold", "xau")
    assert q["status"] == "UNAVAILABLE"


def test_provider_stale_flag_is_respected():
    item = _item(datetime.now(timezone.utc).isoformat())
    item["stale"] = True
    q = _normalise(item, "XAUUSD", "Gold", "xau")
    assert q["status"] == "STALE"
