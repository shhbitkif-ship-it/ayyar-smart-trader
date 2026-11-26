from __future__ import annotations

from datetime import timezone
from typing import Literal, Sequence
from pydantic import BaseModel, Field
from .schemas import Candle

TIMEFRAME_MINUTES = {
    "1m": 1, "5m": 5, "15m": 15, "30m": 30,
    "1h": 60, "4h": 240, "1d": 1440,
}


class CandleQualityRequest(BaseModel):
    timeframe: Literal["1m", "5m", "15m", "30m", "1h", "4h", "1d"] = "15m"
    candles: list[Candle] = Field(min_length=2, max_length=5000)


def inspect_candle_series(candles: Sequence[Candle], timeframe: str) -> dict:
    """Audit an ordered OHLC series without sorting, filling, or hiding gaps."""
    if timeframe not in TIMEFRAME_MINUTES:
        raise ValueError("Unsupported timeframe.")
    interval_ms = TIMEFRAME_MINUTES[timeframe] * 60_000
    duplicate_count = out_of_order_count = misaligned_count = 0
    gap_count = missing_intervals = largest_gap_intervals = 0
    max_gap_seconds = 0.0

    for candle in candles:
        if candle.timestamp.tzinfo is None or candle.timestamp.utcoffset() is None:
            misaligned_count += 1

    for previous, current in zip(candles, candles[1:]):
        if previous.timestamp == current.timestamp:
            duplicate_count += 1
            continue
        delta_ms = (current.timestamp - previous.timestamp).total_seconds() * 1000
        if delta_ms < 0:
            out_of_order_count += 1
            continue
        intervals = round(delta_ms / interval_ms)
        tolerance_ms = max(1000, interval_ms * 0.01)
        if intervals < 1 or abs(delta_ms - intervals * interval_ms) > tolerance_ms:
            misaligned_count += 1
            continue
        if intervals > 1:
            gap_count += 1
            missing_intervals += intervals - 1
            largest_gap_intervals = max(largest_gap_intervals, intervals - 1)
            max_gap_seconds = max(max_gap_seconds, delta_ms / 1000)

    invalid = duplicate_count > 0 or out_of_order_count > 0 or misaligned_count > 0
    status = "INVALID" if invalid else "GAPPED" if gap_count else "CLEAN"
    first_ts = candles[0].timestamp
    last_ts = candles[-1].timestamp
    first = first_ts.astimezone(timezone.utc).isoformat() if first_ts.tzinfo and first_ts.utcoffset() is not None else None
    last = last_ts.astimezone(timezone.utc).isoformat() if last_ts.tzinfo and last_ts.utcoffset() is not None else None
    return {
        "status": status,
        "provider": "USER_SUPPLIED_HISTORICAL_DATA",
        "timeframe": timeframe,
        "timeframe_minutes": TIMEFRAME_MINUTES[timeframe],
        "candle_count": len(candles),
        "first_timestamp_utc": first,
        "last_timestamp_utc": last,
        "duplicate_count": duplicate_count,
        "out_of_order_count": out_of_order_count,
        "misaligned_count": misaligned_count,
        "gap_count": gap_count,
        "missing_intervals": missing_intervals,
        "largest_gap_intervals": largest_gap_intervals,
        "max_gap_seconds": max_gap_seconds,
        "interpolation_applied": False,
        "note": "Gaps are reported, never interpolated or silently ignored. Weekend and session closures are not automatically assumed.",
    }
