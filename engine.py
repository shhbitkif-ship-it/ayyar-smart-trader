from datetime import datetime, timedelta, timezone
from app.indicators import ema, rsi
from app.schemas import EvaluateRequest, SignalResponse

def evaluate(request: EvaluateRequest, now: datetime | None = None) -> SignalResponse:
    now = now or datetime.now(timezone.utc)
    candles = sorted(request.candles, key=lambda item: item.timestamp)
    latest = candles[-1]
    base = dict(symbol=request.symbol.upper(), evaluated_at=now, entry=None,
                stop_loss=None, take_profit_1=None, risk_reward=None)
    if latest.timestamp.tzinfo is None:
        return SignalResponse(**base, action="NO_TRADE", status="STALE",
                              reason="Timestamp must include a timezone.")
    if now - latest.timestamp.astimezone(timezone.utc) > timedelta(minutes=3):
        return SignalResponse(**base, action="NO_TRADE", status="STALE",
                              reason="Latest market candle is stale.")
    if len(candles) < 200:
        return SignalResponse(**base, action="NO_TRADE", status="INSUFFICIENT_DATA",
                              reason="At least 200 one-minute candles are required.")
    closes = [c.close for c in candles]
    fast, slow, momentum = ema(closes, 20), ema(closes, 50), rsi(closes, 14)
    if not fast or not slow or not momentum:
        return SignalResponse(**base, action="NO_TRADE", status="INSUFFICIENT_DATA",
                              reason="Indicator history is incomplete.")
    confirmation = sorted(request.confirmation_candles, key=lambda item: item.timestamp)
    if not confirmation:
        return SignalResponse(**base, action="NO_TRADE", status="NO_SETUP",
                              reason="Five-minute confirmation data is not available.")
    if confirmation[-1].timestamp.tzinfo is None or now - confirmation[-1].timestamp.astimezone(timezone.utc) > timedelta(minutes=10):
        return SignalResponse(**base, action="NO_TRADE", status="STALE",
                              reason="Five-minute confirmation data is stale.")
    cc = [c.close for c in confirmation]
    cf, cs = ema(cc, 20), ema(cc, 50)
    if not cf or not cs:
        return SignalResponse(**base, action="NO_TRADE", status="INSUFFICIENT_DATA",
                              reason="At least 50 five-minute confirmation candles are required.")
    up = fast[-1] > slow[-1] and cf[-1] > cs[-1] and 50 <= momentum[-1] <= 68
    down = fast[-1] < slow[-1] and cf[-1] < cs[-1] and 32 <= momentum[-1] <= 50
    if not (up or down):
        return SignalResponse(**base, action="NO_TRADE", status="NO_SETUP",
                              reason="No aligned multi-timeframe setup.")
    return SignalResponse(**base, action="WAIT", status="NO_SETUP",
                          reason="Trend alignment only; execution levels remain disabled until spread, tick size and contract specs are validated.")
