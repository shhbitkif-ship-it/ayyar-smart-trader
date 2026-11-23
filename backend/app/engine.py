from datetime import datetime,timedelta,timezone
from .indicators import ema,rsi,macd,bollinger,atr,vwap,support_resistance,fibonacci_levels
from .schemas import EvaluateRequest,SignalResponse

TIMEFRAME_AGE={"1m":3,"5m":10,"15m":30,"30m":60,"1h":120,"4h":480,"1d":2880}

def evaluate(request: EvaluateRequest, now: datetime | None = None) -> SignalResponse:
    now=now or datetime.now(timezone.utc)
    candles=sorted(request.candles,key=lambda x:x.timestamp); latest=candles[-1]
    base=dict(symbol=request.symbol.upper(),evaluated_at=now,entry=None,stop_loss=None,take_profit_1=None,risk_reward=None,analysis={})
    if latest.timestamp.tzinfo is None: return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Timestamp must include a timezone.")
    latest_time=latest.timestamp.astimezone(timezone.utc); max_age=TIMEFRAME_AGE[request.timeframe]
    if latest_time > now+timedelta(seconds=30) or now-latest_time>timedelta(minutes=max_age):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Latest market candle is stale or future-dated.")
    if len(candles)<200: return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="At least 200 candles are required for EMA200 and stable trend context.")
    highs=[c.high for c in candles]; lows=[c.low for c in candles]; closes=[c.close for c in candles]; volumes=[c.volume for c in candles]
    e20,e50,e100,e200=[ema(closes,p) for p in (20,50,100,200)]; momentum=rsi(closes,14)
    if not all((e20,e50,e100,e200,momentum)): return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="Indicator history is incomplete.")
    analysis={"ema20":e20[-1],"ema50":e50[-1],"ema100":e100[-1],"ema200":e200[-1],"rsi14":momentum[-1],
              "macd":macd(closes),"bollinger20":bollinger(closes),"atr14":atr(highs,lows,closes),
              "vwap":vwap(highs,lows,closes,volumes),"support_resistance":support_resistance(highs,lows),
              "fibonacci":fibonacci_levels(highs,lows)}
    base["analysis"]=analysis
    confirm=sorted(request.confirmation_candles,key=lambda x:x.timestamp)
    if not confirm: return SignalResponse(**base,action="NO_TRADE",status="NO_SETUP",reason="Higher-timeframe confirmation data is not available.")
    confirm_time=confirm[-1].timestamp
    if confirm_time.tzinfo is None: return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Confirmation candle timestamp must include a timezone.")
    confirm_time=confirm_time.astimezone(timezone.utc)
    if confirm_time>now+timedelta(seconds=30) or now-confirm_time>timedelta(minutes=max_age*2):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Higher-timeframe confirmation data is stale or future-dated.")
    cc=[c.close for c in confirm]; cf,cs=ema(cc,20),ema(cc,50)
    if not cf or not cs: return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="At least 50 confirmation candles are required.")
    up=e20[-1]>e50[-1]>e100[-1]>e200[-1] and cf[-1]>cs[-1] and 50<=momentum[-1]<=68
    down=e20[-1]<e50[-1]<e100[-1]<e200[-1] and cf[-1]<cs[-1] and 32<=momentum[-1]<=50
    reason="Trend alignment only. No executable entry is issued until market spread, tick size, contract size, liquidity and risk sizing are verified." if up or down else "No aligned multi-timeframe setup; wait for confirmation."
    return SignalResponse(**base,action="WAIT" if up or down else "NO_TRADE",status="NO_SETUP",reason=reason)
