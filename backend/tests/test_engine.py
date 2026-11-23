from datetime import datetime,timedelta,timezone
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
