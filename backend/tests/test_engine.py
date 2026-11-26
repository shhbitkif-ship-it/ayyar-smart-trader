from datetime import datetime,timedelta,timezone
import pytest
from pydantic import ValidationError
from app.engine import evaluate
from app.schemas import Candle,EvaluateRequest

def candles(n,step,start):
 return [Candle(timestamp=start+timedelta(minutes=step*i),open=2600+i*.1,high=2600+i*.1+.2,low=2600+i*.1-.2,close=2600+i*.1,volume=10) for i in range(n)]

def test_insufficient_data_is_no_trade():
 now=datetime.now(timezone.utc); req=EvaluateRequest(symbol="XAUUSD",candles=candles(20,1,now-timedelta(minutes=19)))
 out=evaluate(req,now); assert out.action=="NO_TRADE" and out.status=="INSUFFICIENT_DATA"

def test_missing_confirmation_is_no_trade():
 now=datetime.now(timezone.utc); req=EvaluateRequest(symbol="XAUUSD",candles=candles(220,1,now-timedelta(minutes=219)))
 out=evaluate(req,now); assert out.action=="NO_TRADE" and "confirmation" in out.reason.lower()

def test_stale_data_rejected():
 now=datetime.now(timezone.utc); req=EvaluateRequest(symbol="XAUUSD",candles=candles(220,1,now-timedelta(hours=6)))
 assert evaluate(req,now).status=="STALE"

def test_future_data_rejected():
 now=datetime.now(timezone.utc); req=EvaluateRequest(symbol="XAUUSD",candles=candles(220,1,now+timedelta(minutes=1)))
 assert evaluate(req,now).status=="STALE"


def test_analysis_includes_requested_indicators():
 now=datetime.now(timezone.utc)
 req=EvaluateRequest(symbol="XAUUSD",candles=candles(220,1,now-timedelta(minutes=219)))
 out=evaluate(req,now)
 assert out.action=="NO_TRADE"
 assert {"ema20","ema50","ema100","ema200","rsi14","macd","bollinger20","atr14","support_resistance","fibonacci"} <= set(out.analysis)


@pytest.mark.parametrize("field", ["open", "high", "low", "close", "volume"])
@pytest.mark.parametrize("bad_value", [float("nan"), float("inf"), float("-inf")])
def test_candle_rejects_non_finite_market_values(field, bad_value):
    values = dict(timestamp=datetime.now(timezone.utc), open=100, high=101, low=99, close=100, volume=10)
    values[field] = bad_value
    with pytest.raises(ValidationError):
        Candle(**values)


def test_duplicate_market_candle_timestamps_are_rejected():
    now = datetime.now(timezone.utc)
    data = candles(220, 1, now - timedelta(minutes=220))
    data[-1] = data[-2].model_copy()
    req = EvaluateRequest(symbol="XAUUSD", candles=data)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "duplicate" in result.reason.lower()


def test_naive_timestamp_in_any_market_candle_is_rejected():
    now = datetime.now(timezone.utc)
    data = candles(220, 1, now - timedelta(minutes=220))
    data[0] = data[0].model_copy(update={"timestamp": data[0].timestamp.replace(tzinfo=None)})
    req = EvaluateRequest(symbol="XAUUSD", candles=data)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "every market candle" in result.reason.lower()


def test_confirmation_candle_newer_than_market_data_is_rejected():
    now = datetime.now(timezone.utc)
    market = candles(220, 1, now - timedelta(minutes=221))
    confirmation = candles(60, 5, market[-1].timestamp - timedelta(minutes=296))
    confirmation[-1] = confirmation[-1].model_copy(update={"timestamp": market[-1].timestamp + timedelta(minutes=1)})
    req = EvaluateRequest(symbol="XAUUSD", candles=market, confirmation_candles=confirmation)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "confirmation data is stale" in result.reason.lower()


def test_duplicate_confirmation_timestamps_are_rejected():
    now = datetime.now(timezone.utc)
    market = candles(220, 1, now - timedelta(minutes=220))
    confirmation = candles(60, 1, now - timedelta(minutes=60))
    confirmation[-1] = confirmation[-2].model_copy()
    req = EvaluateRequest(symbol="XAUUSD", candles=market, confirmation_candles=confirmation)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "duplicate confirmation" in result.reason.lower()


@pytest.mark.parametrize("timeframe,step", [("1m", 5), ("5m", 20), ("15m", 60), ("30m", 120), ("1h", 240)])
def test_large_intraday_history_gap_is_no_trade(timeframe, step):
    now = datetime.now(timezone.utc)
    data = candles(220, 1, now - timedelta(minutes=220))
    # Introduce a gap well beyond the permitted interval in the middle.
    for index in range(110, len(data)):
        data[index] = data[index].model_copy(update={"timestamp": data[index].timestamp + timedelta(minutes=step)})
    req = EvaluateRequest(symbol="XAUUSD", timeframe=timeframe, candles=data)
    result = evaluate(req, now + timedelta(minutes=step))
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "gap" in result.reason.lower()


def test_daily_history_allows_weekend_gap():
    now = datetime.now(timezone.utc)
    data = candles(220, 1440, now - timedelta(days=222))
    data[150:] = [c.model_copy(update={"timestamp": c.timestamp + timedelta(days=2)}) for c in data[150:]]
    req = EvaluateRequest(symbol="XAUUSD", timeframe="1d", candles=data)
    result = evaluate(req, now)
    assert result.status != "STALE" or "gap" not in result.reason.lower()


def test_out_of_order_market_candles_are_rejected_without_sorting():
    now = datetime.now(timezone.utc)
    data = candles(220, 1, now - timedelta(minutes=220))
    data[100], data[101] = data[101], data[100]
    req = EvaluateRequest(symbol="XAUUSD", candles=data)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "out of order" in result.reason.lower()


def test_out_of_order_confirmation_candles_are_rejected():
    now = datetime.now(timezone.utc)
    market = candles(220, 1, now - timedelta(minutes=220))
    confirmation = candles(60, 1, now - timedelta(minutes=60))
    confirmation[20], confirmation[21] = confirmation[21], confirmation[20]
    req = EvaluateRequest(symbol="XAUUSD", candles=market, confirmation_candles=confirmation)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "out of order" in result.reason.lower()
