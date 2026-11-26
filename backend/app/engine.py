from datetime import datetime,timedelta,timezone
from hashlib import sha256
import math
from .indicators import ema,rsi,macd,bollinger,atr,vwap,support_resistance,fibonacci_levels
from .schemas import EvaluateRequest,SignalResponse

TIMEFRAME_AGE={"1m":3,"5m":10,"15m":30,"30m":60,"1h":120,"4h":480,"1d":2880}
TIMEFRAME_MINUTES={"1m":1,"5m":5,"15m":15,"30m":30,"1h":60,"4h":240,"1d":1440}


def _classify_market_regime(e20, e50, e100, e200, closes, momentum, atr_values):
    """Classify trend from aligned EMA structure, short EMA slope and volatility."""
    if any(len(series) < 6 for series in (e20, e50, e100, e200, closes, momentum)):
        return {"trend": "UNKNOWN", "trend_strength": "UNKNOWN",
                "momentum_state": "UNKNOWN", "volatility_pct": None, "volatility_regime": "UNKNOWN",
                "trend_spread_pct": None, "trend_slope_pct": None,
                "signal_quality": "INSUFFICIENT"}
    price = closes[-1]
    # indicators.atr returns one current ATR value, not a historical list.
    atr_current = atr_values[-1] if isinstance(atr_values, (list, tuple)) else atr_values
    if price <= 0 or atr_current is None or not math.isfinite(float(atr_current)) or atr_current < 0:
        return {"trend": "UNKNOWN", "trend_strength": "UNKNOWN",
                "momentum_state": "UNKNOWN", "volatility_pct": None, "volatility_regime": "UNKNOWN",
                "trend_spread_pct": None, "trend_slope_pct": None,
                "signal_quality": "INSUFFICIENT"}
    spread_pct = abs(e20[-1] - e200[-1]) / price * 100
    slope_pct = (e20[-1] - e20[-6]) / price * 100
    volatility_pct = atr_current / price * 100
    volatility_regime = ("HIGH" if volatility_pct > 2.0 else
                         "LOW" if volatility_pct < 0.015 else "NORMAL")
    bullish_stack = e20[-1] > e50[-1] > e100[-1] > e200[-1]
    bearish_stack = e20[-1] < e50[-1] < e100[-1] < e200[-1]
    if bullish_stack and slope_pct > 0.01:
        trend = "BULLISH"
    elif bearish_stack and slope_pct < -0.01:
        trend = "BEARISH"
    else:
        trend = "SIDEWAYS"
    strength = ("STRONG" if spread_pct >= 0.50 else
                "MODERATE" if spread_pct >= 0.15 else "WEAK")
    momentum_state = ("OVERBOUGHT" if momentum[-1] >= 70 else
                      "OVERSOLD" if momentum[-1] <= 30 else
                      "BULLISH" if momentum[-1] > 55 else
                      "BEARISH" if momentum[-1] < 45 else "NEUTRAL")
    quality = "GOOD"
    if trend == "SIDEWAYS" or strength == "WEAK":
        quality = "WEAK"
    if volatility_regime != "NORMAL":
        quality = "WEAK"
    return {"trend": trend, "trend_strength": strength,
            "momentum_state": momentum_state,
            "volatility_pct": round(volatility_pct, 5),
            "volatility_regime": volatility_regime,
            "trend_spread_pct": round(spread_pct, 5),
            "trend_slope_pct": round(slope_pct, 5),
            "signal_quality": quality}

def evaluate(request: EvaluateRequest, now: datetime | None = None) -> SignalResponse:
    now=now or datetime.now(timezone.utc)
    base=dict(symbol=request.symbol.upper(),evaluated_at=now,entry=None,stop_loss=None,take_profit_1=None,risk_reward=None,analysis={})
    if any(c.timestamp.tzinfo is None or c.timestamp.utcoffset() is None for c in request.candles):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Every market candle timestamp must include a timezone.")
    candles=list(request.candles)
    if any(candles[i].timestamp == candles[i + 1].timestamp for i in range(len(candles)-1)):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Duplicate market candle timestamps detected.")
    if any(candles[i].timestamp > candles[i + 1].timestamp for i in range(len(candles)-1)):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Market candle timestamps are out of order; input history must be strictly chronological.")
    # Check series integrity before checking the latest candle's age.
    # Daily/4h series are exempt because weekends and market closures are normal.
    if request.timeframe in {"1m", "5m", "15m", "30m", "1h"}:
        max_gap=timedelta(minutes=TIMEFRAME_MINUTES[request.timeframe] * 3.5)
        if any(candles[i + 1].timestamp - candles[i].timestamp > max_gap for i in range(len(candles)-1)):
            return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Missing candles create a gap in the intraday market history.")
    latest=candles[-1]
    latest_time=latest.timestamp.astimezone(timezone.utc); max_age=TIMEFRAME_AGE[request.timeframe]
    if latest_time > now+timedelta(seconds=30) or now-latest_time>timedelta(minutes=max_age):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Latest market candle is stale or future-dated.")
    if len(candles)<200: return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="At least 200 candles are required for EMA200 and stable trend context.")
    highs=[c.high for c in candles]; lows=[c.low for c in candles]; closes=[c.close for c in candles]; volumes=[c.volume for c in candles]
    e20,e50,e100,e200=[ema(closes,p) for p in (20,50,100,200)]; momentum=rsi(closes,14)
    if not all((e20,e50,e100,e200,momentum)): return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="Indicator history is incomplete.")
    atr_values=atr(highs,lows,closes)
    regime=_classify_market_regime(e20,e50,e100,e200,closes,momentum,atr_values)
    analysis={"ema20":e20[-1],"ema50":e50[-1],"ema100":e100[-1],"ema200":e200[-1],"rsi14":momentum[-1],
              "macd":macd(closes),"bollinger20":bollinger(closes),"atr14":atr_values,
              "vwap":vwap(highs,lows,closes,volumes),"support_resistance":support_resistance(highs,lows),
              "fibonacci":fibonacci_levels(highs,lows),**regime,
              "setup_direction":"NONE","setup_detected":False,"signal_key":None}
    base["analysis"]=analysis
    if not request.confirmation_candles: return SignalResponse(**base,action="NO_TRADE",status="NO_SETUP",reason="Higher-timeframe confirmation data is not available.")
    if any(c.timestamp.tzinfo is None or c.timestamp.utcoffset() is None for c in request.confirmation_candles):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Every confirmation candle timestamp must include a timezone.")
    confirm=list(request.confirmation_candles)
    if any(confirm[i].timestamp == confirm[i + 1].timestamp for i in range(len(confirm)-1)):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Duplicate confirmation candle timestamps detected.")
    if any(confirm[i].timestamp > confirm[i + 1].timestamp for i in range(len(confirm)-1)):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Confirmation candle timestamps are out of order; input history must be strictly chronological.")
    confirm_time=confirm[-1].timestamp
    confirm_time=confirm_time.astimezone(timezone.utc)
    if confirm_time>now+timedelta(seconds=30) or confirm_time>latest_time+timedelta(seconds=30) or now-confirm_time>timedelta(minutes=max_age*2):
        return SignalResponse(**base,action="NO_TRADE",status="STALE",reason="Higher-timeframe confirmation data is stale or future-dated.")
    cc=[c.close for c in confirm]; cf,cs=ema(cc,20),ema(cc,50)
    if not cf or not cs: return SignalResponse(**base,action="NO_TRADE",status="INSUFFICIENT_DATA",reason="At least 50 confirmation candles are required.")
    up=regime["trend"]=="BULLISH" and regime["signal_quality"]=="GOOD" and cf[-1]>cs[-1] and 50<=momentum[-1]<=68
    down=regime["trend"]=="BEARISH" and regime["signal_quality"]=="GOOD" and cf[-1]<cs[-1] and 32<=momentum[-1]<=50
    # A detected setup is informational only. Order execution remains disabled.
    analysis["setup_direction"] = "LONG" if up else "SHORT" if down else "NONE"
    analysis["setup_detected"] = bool(up or down)
    analysis["signal_key"] = (
        sha256(f"{request.symbol.upper()}|{request.timeframe}|{latest_time.isoformat()}|{analysis['setup_direction']}".encode()).hexdigest()
        if up or down else None
    )
    if up or down:
        action="WAIT"
        reason="Trend and higher-timeframe alignment detected. Entry remains disabled pending spread, tick size, contract size, liquidity and risk verification."
    else:
        action="NO_TRADE"
        reason=("Weak or sideways market conditions; low-quality setups are filtered."
                if regime["signal_quality"]!="GOOD" or regime["trend"]=="SIDEWAYS"
                else "No aligned multi-timeframe confirmation; wait.")
    return SignalResponse(**base,action=action,status="NO_SETUP",reason=reason)
