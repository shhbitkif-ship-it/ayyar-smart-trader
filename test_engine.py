from datetime import datetime, timedelta, timezone
from app.engine import evaluate
from app.schemas import Candle, EvaluateRequest

def make_candles(n, step, start):
    return [Candle(timestamp=start + timedelta(minutes=step*i),
                   open=2600+i*.1, high=2600+i*.1+.2,
                   low=2600+i*.1-.2, close=2600+i*.1, volume=10)
            for i in range(n)]

def test_insufficient_data_no_trade():
    now = datetime.now(timezone.utc)
    req = EvaluateRequest(symbol="XAUUSD",
                          candles=make_candles(20, 1, now-timedelta(minutes=19)))
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "INSUFFICIENT_DATA"

def test_missing_confirmation_no_trade():
    now = datetime.now(timezone.utc)
    req = EvaluateRequest(symbol="XAUUSD",
                          candles=make_candles(220, 1, now-timedelta(minutes=219)))
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert "confirmation" in result.reason.lower()

def test_stale_data_rejected():
    now = datetime.now(timezone.utc)
    req = EvaluateRequest(symbol="XAUUSD",
                          candles=make_candles(220, 1, now-timedelta(hours=2)))
    result = evaluate(req, now)
    assert result.status == "STALE"
