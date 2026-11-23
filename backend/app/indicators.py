from collections.abc import Sequence

def ema(values: Sequence[float], period: int) -> list[float]:
    if period <= 0: raise ValueError("period must be positive")
    if len(values) < period: return []
    alpha = 2 / (period + 1)
    out = [sum(values[:period]) / period]
    for value in values[period:]: out.append(alpha * value + (1-alpha) * out[-1])
    return out

def rsi(values: Sequence[float], period: int = 14) -> list[float]:
    if period <= 0: raise ValueError("period must be positive")
    if len(values) <= period: return []
    gains=[max(values[i]-values[i-1],0.0) for i in range(1,len(values))]
    losses=[max(values[i-1]-values[i],0.0) for i in range(1,len(values))]
    ag=sum(gains[:period])/period; al=sum(losses[:period])/period
    def calc(g,l): return 100.0 if l==0 and g>0 else 50.0 if l==0 else 100-100/(1+g/l)
    out=[calc(ag,al)]
    for i in range(period,len(gains)):
        ag=(ag*(period-1)+gains[i])/period; al=(al*(period-1)+losses[i])/period
        out.append(calc(ag,al))
    return out


def sma(values: Sequence[float], period: int) -> list[float]:
    if period <= 0: raise ValueError("period must be positive")
    return [sum(values[i-period+1:i+1])/period for i in range(period-1,len(values))]

def macd(values: Sequence[float], fast: int=12, slow: int=26, signal: int=9) -> dict:
    f,s=ema(values,fast),ema(values,slow)
    if not f or not s: return {}
    offset=slow-fast; line=[f[i+offset]-s[i] for i in range(len(s))]
    sig=ema(line,signal)
    if not sig: return {"macd":line[-1]}
    return {"macd":line[-1],"signal":sig[-1],"histogram":line[-1]-sig[-1]}

def bollinger(values: Sequence[float], period: int=20, deviations: float=2.0) -> dict:
    if len(values)<period: return {}
    window=list(values[-period:]); mean=sum(window)/period
    variance=sum((x-mean)**2 for x in window)/period; sd=variance**0.5
    return {"middle":mean,"upper":mean+deviations*sd,"lower":mean-deviations*sd}

def atr(highs: Sequence[float], lows: Sequence[float], closes: Sequence[float], period: int=14) -> float | None:
    if len(closes)<period+1 or len(highs)!=len(lows) or len(highs)!=len(closes): return None
    tr=[max(highs[i]-lows[i],abs(highs[i]-closes[i-1]),abs(lows[i]-closes[i-1])) for i in range(1,len(closes))]
    return sum(tr[-period:])/period

def vwap(highs: Sequence[float], lows: Sequence[float], closes: Sequence[float], volumes: Sequence[float | None]) -> float | None:
    if not volumes or len(highs)!=len(lows) or len(highs)!=len(closes) or len(closes)!=len(volumes): return None
    valid=[( (highs[i]+lows[i]+closes[i])/3, volumes[i]) for i in range(len(closes)) if volumes[i] is not None and volumes[i]>0]
    total=sum(v for _,v in valid)
    return sum(p*v for p,v in valid)/total if total>0 else None

def support_resistance(highs: Sequence[float], lows: Sequence[float], lookback: int=50) -> dict:
    if not highs or not lows: return {}
    return {"support":min(lows[-lookback:]),"resistance":max(highs[-lookback:])}

def fibonacci_levels(highs: Sequence[float], lows: Sequence[float], lookback: int=100) -> dict:
    if not highs or not lows: return {}
    high=max(highs[-lookback:]); low=min(lows[-lookback:]); span=high-low
    if span<=0: return {}
    return {str(level):high-span*level for level in (0.236,0.382,0.5,0.618,0.786)}
