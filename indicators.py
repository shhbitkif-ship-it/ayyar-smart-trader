from collections.abc import Sequence

def ema(values: Sequence[float], period: int) -> list[float]:
    if period <= 0:
        raise ValueError("period must be positive")
    if len(values) < period:
        return []
    alpha = 2 / (period + 1)
    result = [sum(values[:period]) / period]
    for value in values[period:]:
        result.append(alpha * value + (1 - alpha) * result[-1])
    return result

def rsi(values: Sequence[float], period: int = 14) -> list[float]:
    if period <= 0:
        raise ValueError("period must be positive")
    if len(values) <= period:
        return []
    gains = [max(values[i] - values[i - 1], 0.0) for i in range(1, len(values))]
    losses = [max(values[i - 1] - values[i], 0.0) for i in range(1, len(values))]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    def value(g, l):
        return 100.0 if l == 0 and g > 0 else 50.0 if l == 0 else 100 - 100 / (1 + g / l)
    result = [value(avg_gain, avg_loss)]
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        result.append(value(avg_gain, avg_loss))
    return result
