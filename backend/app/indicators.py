from collections.abc import Sequence
import math


def _positive_period(period: int, name: str = "period") -> None:
    if isinstance(period, bool) or not isinstance(period, int) or period <= 0:
        raise ValueError(f"{name} must be a positive integer.")


def _finite_values(values: Sequence[float], name: str = "values") -> None:
    if any(not math.isfinite(float(value)) for value in values):
        raise ValueError(f"{name} must contain only finite numbers.")


def ema(values: Sequence[float], period: int) -> list[float]:
    _positive_period(period)
    _finite_values(values)
    if len(values) < period:
        return []
    alpha = 2 / (period + 1)
    out = [sum(values[:period]) / period]
    for value in values[period:]:
        out.append(alpha * value + (1 - alpha) * out[-1])
    return out


def rsi(values: Sequence[float], period: int = 14) -> list[float]:
    _positive_period(period)
    _finite_values(values)
    if len(values) <= period:
        return []
    gains = [max(values[i] - values[i - 1], 0.0) for i in range(1, len(values))]
    losses = [max(values[i - 1] - values[i], 0.0) for i in range(1, len(values))]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    def calculate(gain: float, loss: float) -> float:
        if loss == 0:
            return 100.0 if gain > 0 else 50.0
        return 100.0 - 100.0 / (1.0 + gain / loss)

    out = [calculate(avg_gain, avg_loss)]
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        out.append(calculate(avg_gain, avg_loss))
    return out


def sma(values: Sequence[float], period: int) -> list[float]:
    _positive_period(period)
    _finite_values(values)
    return [
        sum(values[i - period + 1:i + 1]) / period
        for i in range(period - 1, len(values))
    ]


def macd(values: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    _positive_period(fast, "fast period")
    _positive_period(slow, "slow period")
    _positive_period(signal, "signal period")
    if fast >= slow:
        raise ValueError("fast period must be smaller than slow period.")
    _finite_values(values)
    fast_ema, slow_ema = ema(values, fast), ema(values, slow)
    if not fast_ema or not slow_ema:
        return {}
    offset = slow - fast
    line = [fast_ema[i + offset] - slow_ema[i] for i in range(len(slow_ema))]
    signal_line = ema(line, signal)
    if not signal_line:
        return {"macd": line[-1]}
    return {
        "macd": line[-1],
        "signal": signal_line[-1],
        "histogram": line[-1] - signal_line[-1],
    }


def bollinger(values: Sequence[float], period: int = 20, deviations: float = 2.0) -> dict:
    _positive_period(period)
    if not math.isfinite(deviations) or deviations < 0:
        raise ValueError("deviations must be a finite non-negative number.")
    _finite_values(values)
    if len(values) < period:
        return {}
    window = list(values[-period:])
    mean = sum(window) / period
    variance = sum((value - mean) ** 2 for value in window) / period
    standard_deviation = variance ** 0.5
    return {
        "middle": mean,
        "upper": mean + deviations * standard_deviation,
        "lower": mean - deviations * standard_deviation,
    }


def atr(
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    period: int = 14,
) -> float | None:
    _positive_period(period)
    if len(highs) != len(lows) or len(highs) != len(closes):
        return None
    _finite_values(highs, "highs")
    _finite_values(lows, "lows")
    _finite_values(closes, "closes")
    if len(closes) < period + 1:
        return None
    if any(high < low for high, low in zip(highs, lows)):
        raise ValueError("Each high must be greater than or equal to its low.")
    true_ranges = [
        max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        for i in range(1, len(closes))
    ]
    return sum(true_ranges[-period:]) / period


def vwap(
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    volumes: Sequence[float | None],
) -> float | None:
    if len(highs) != len(lows) or len(highs) != len(closes) or len(closes) != len(volumes):
        return None
    _finite_values(highs, "highs")
    _finite_values(lows, "lows")
    _finite_values(closes, "closes")
    if any(volume is not None and not math.isfinite(float(volume)) for volume in volumes):
        raise ValueError("volumes must contain only finite numbers or None.")
    if any(high < low for high, low in zip(highs, lows)):
        raise ValueError("Each high must be greater than or equal to its low.")
    valid = [
        ((highs[i] + lows[i] + closes[i]) / 3, volumes[i])
        for i in range(len(closes))
        if volumes[i] is not None and volumes[i] > 0
    ]
    total_volume = sum(volume for _, volume in valid)
    if total_volume <= 0:
        return None
    return sum(price * volume for price, volume in valid) / total_volume


def support_resistance(highs: Sequence[float], lows: Sequence[float], lookback: int = 50) -> dict:
    _positive_period(lookback, "lookback")
    if len(highs) != len(lows):
        return {}
    _finite_values(highs, "highs")
    _finite_values(lows, "lows")
    if any(high < low for high, low in zip(highs, lows)):
        raise ValueError("Each high must be greater than or equal to its low.")
    if not highs:
        return {}
    return {"support": min(lows[-lookback:]), "resistance": max(highs[-lookback:])}


def fibonacci_levels(highs: Sequence[float], lows: Sequence[float], lookback: int = 100) -> dict:
    _positive_period(lookback, "lookback")
    if len(highs) != len(lows):
        return {}
    _finite_values(highs, "highs")
    _finite_values(lows, "lows")
    if any(high < low for high, low in zip(highs, lows)):
        raise ValueError("Each high must be greater than or equal to its low.")
    if not highs:
        return {}
    high = max(highs[-lookback:])
    low = min(lows[-lookback:])
    span = high - low
    if span <= 0:
        return {}
    return {str(level): high - span * level for level in (0.236, 0.382, 0.5, 0.618, 0.786)}
