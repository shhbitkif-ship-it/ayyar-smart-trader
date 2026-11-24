from datetime import datetime, timezone, timedelta
from app.market_data import _normalise, _timestamp, MAX_AGE_SECONDS


def _item(updated_utc, unit="USD"):
    return {"price": 2300, "unit": unit, "updated_utc": updated_utc, "stale": False}


def test_timestamp_parses_timezone():
    assert _timestamp("2026-11-23T18:00:00+03:30").utcoffset() == timedelta(hours=3, minutes=30)


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


def test_provider_stale_flag_is_respected():
    item = _item(datetime.now(timezone.utc).isoformat())
    item["stale"] = True
    q = _normalise(item, "XAUUSD", "Gold", "xau")
    assert q["status"] == "STALE"
