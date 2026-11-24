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
