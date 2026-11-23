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
