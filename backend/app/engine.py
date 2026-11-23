from datetime import datetime,timedelta,timezone
from .indicators import ema,rsi
from .schemas import EvaluateRequest,SignalResponse

def evaluate(request: EvaluateRequest, now: datetime | None = None) -> SignalResponse:
    now=now or datetime.now(timezone.utc)
    candles=sorted(request.candles,key=lambda x:x.timestamp); latest=candles[-1]
    base=dict(symbol=request.symbol.upper(),evaluated_at=now,entry=None,stop_loss=None,take_profit_1=None,risk_reward=None)
    if latest.timestamp.tzinfo is None: return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Timestamp must include a timezone.")
    if now-latest.timestamp.astimezone(timezone.utc)>timedelta(minutes=3): return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Latest market candle is stale.")
    if len(candles)<200: return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="At least 200 one-minute candles are required.")
    closes=[c.close for c in candles]; fast,slow,momentum=ema(closes,20),ema(closes,50),rsi(closes,14)
    if not fast or not slow or not momentum: return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="Indicator history is incomplete.")
    confirm=sorted(request.confirmation_candles,key=lambda x:x.timestamp)
    if not confirm: return SignalResponse(**base,action="NO_TRADE",status="NO_SETUP",reason="Five-minute confirmation data is not available.")
    if confirm[-1].timestamp.tzinfo is None or now-confirm[-1].timestamp.astimezone(timezone.utc)>timedelta(minutes=10): return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Five-minute confirmation data is stale.")
    cc=[c.close for c in confirm]; cf,cs=ema(cc,20),ema(cc,50)
    if not cf or not cs: return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="At least 50 five-minute confirmation candles are required.")
    up=fast[-1]>slow[-1] and cf[-1]>cs[-1] and 50<=momentum[-1]<=68
    down=fast[-1]<slow[-1] and cf[-1]<cs[-1] and 32<=momentum[-1]<=50
    reason="Trend alignment only; execution levels remain disabled until spread, tick size and contract specs are validated." if up or down else "No aligned multi-timeframe setup."
    return SignalResponse(**base,action="WAIT" if up or down else "NO_TRADE",status="NO_SETUP",reason=reason)
