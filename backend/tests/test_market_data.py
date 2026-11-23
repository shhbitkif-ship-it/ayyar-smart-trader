from datetime import datetime, timezone, timedelta
from app.market_data import _quote, _timestamp

def test_quote_rejects_missing_timestamp():
    q = _quote("XAUUSD", "Gold", 2300, "USD/oz", "test", None)
    assert q["status"] == "STALE"

def test_quote_marks_old_data_stale():
    q = _quote("XAUUSD", "Gold", 2300, "USD/oz", "test", datetime.now(timezone.utc)-timedelta(minutes=5))
    assert q["status"] == "STALE"

def test_quote_accepts_recent_timestamp():
    q = _quote("XAUUSD", "Gold", 2300, "USD/oz", "test", datetime.now(timezone.utc))
    assert q["status"] == "LIVE"

def test_timestamp_parses_timezone():
    assert _timestamp("2026-11-23T18:00:00+03:30").utcoffset() == timedelta(hours=3, minutes=30)
