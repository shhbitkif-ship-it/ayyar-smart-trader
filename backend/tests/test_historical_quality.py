from datetime import datetime, timedelta, timezone
from app.historical_quality import inspect_candle_series
from app.schemas import Candle


def series(minutes=(15, 15, 15)):
    start = datetime(2026, 11, 2, tzinfo=timezone.utc)
    offsets = [0]
    for delta in minutes:
        offsets.append(offsets[-1] + delta)
    return [
        Candle(timestamp=start + timedelta(minutes=offset), open=3000, high=3002, low=2998, close=3001)
        for offset in offsets
    ]


def test_quality_audit_reports_clean_series():
    result = inspect_candle_series(series(), "15m")
    assert result["status"] == "CLEAN"
    assert result["candle_count"] == 4
    assert result["gap_count"] == 0
    assert result["interpolation_applied"] is False


def test_quality_audit_reports_missing_intervals_without_filling():
    result = inspect_candle_series(series((15, 45, 15)), "15m")
    assert result["status"] == "GAPPED"
    assert result["gap_count"] == 1
    assert result["missing_intervals"] == 2
    assert result["largest_gap_intervals"] == 2
    assert result["candle_count"] == 4
    assert result["interpolation_applied"] is False


def test_quality_audit_detects_duplicate_timestamps():
    candles = series()
    candles[2] = candles[1].model_copy()
    result = inspect_candle_series(candles, "15m")
    assert result["status"] == "INVALID"
    assert result["duplicate_count"] == 1


def test_quality_audit_detects_out_of_order_timestamps():
    candles = series()
    candles[1], candles[2] = candles[2], candles[1]
    result = inspect_candle_series(candles, "15m")
    assert result["status"] == "INVALID"
    assert result["out_of_order_count"] == 1


def test_quality_audit_detects_irregular_interval():
    result = inspect_candle_series(series((15, 17, 15)), "15m")
    assert result["status"] == "INVALID"
    assert result["misaligned_count"] == 1


def test_quality_audit_reports_weekend_span_as_gap_not_assumed_closure():
    start = datetime(2026, 11, 6, 21, 45, tzinfo=timezone.utc)
    candles = [
        Candle(timestamp=start, open=3000, high=3002, low=2998, close=3001),
        Candle(timestamp=start + timedelta(hours=49, minutes=15), open=3001, high=3003, low=2999, close=3002),
    ]
    result = inspect_candle_series(candles, "15m")
    assert result["status"] == "GAPPED"
    assert result["missing_intervals"] > 100
    assert "not automatically assumed" in result["note"]
