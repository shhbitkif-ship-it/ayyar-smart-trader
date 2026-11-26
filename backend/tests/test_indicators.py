import math
import pytest

from app.indicators import (
    atr, bollinger, ema, fibonacci_levels, macd, rsi, sma,
    support_resistance, vwap,
)


@pytest.mark.parametrize("fn,args", [
    (ema, ([1, 2], 0)),
    (rsi, ([1, 2], -1)),
    (sma, ([1, 2], 0)),
    (atr, ([2, 3], [1, 2], [1, 2], 0)),
    (bollinger, ([1, 2], 0)),
    (support_resistance, ([2], [1], 0)),
    (fibonacci_levels, ([2], [1], -2)),
])
def test_period_parameters_must_be_positive(fn, args):
    with pytest.raises(ValueError):
        fn(*args)


@pytest.mark.parametrize("fn,args", [
    (ema, ([1.0, float("nan"), 2.0], 2)),
    (rsi, ([1.0, float("inf"), 2.0], 2)),
    (sma, ([1.0, 2.0, float("-inf")], 2)),
    (bollinger, ([1.0, 2.0, float("nan")], 2)),
])
def test_price_indicators_reject_non_finite_values(fn, args):
    with pytest.raises(ValueError, match="finite"):
        fn(*args)


def test_macd_requires_fast_period_below_slow_period():
    with pytest.raises(ValueError, match="smaller"):
        macd([float(i) for i in range(60)], fast=26, slow=12)


@pytest.mark.parametrize("deviations", [-1, float("nan"), float("inf")])
def test_bollinger_rejects_invalid_deviation_count(deviations):
    with pytest.raises(ValueError, match="deviations"):
        bollinger([float(i) for i in range(30)], deviations=deviations)


def test_rsi_flat_market_is_neutral_and_bounded():
    result = rsi([100.0] * 20, period=14)
    assert result
    assert all(0 <= value <= 100 for value in result)
    assert result[-1] == 50.0


def test_rsi_monotonic_up_and_down_are_bounded_extremes():
    assert rsi([float(i) for i in range(20)], 14)[-1] == 100.0
    assert rsi([float(20 - i) for i in range(20)], 14)[-1] == 0.0


def test_atr_uses_previous_close_and_rejects_invalid_ohlc():
    value = atr([12, 15, 14], [9, 11, 10], [10, 13, 12], period=2)
    assert value == pytest.approx(4.0)
    with pytest.raises(ValueError, match="high"):
        atr([8, 7], [9, 6], [8, 7], period=1)


def test_vwap_ignores_missing_and_non_positive_volume():
    assert vwap([11, 21, 31], [9, 19, 29], [10, 20, 30], [2, None, 0]) == pytest.approx(10)


def test_vwap_returns_none_without_positive_volume():
    assert vwap([11], [9], [10], [0]) is None


def test_vwap_rejects_non_finite_volume():
    with pytest.raises(ValueError, match="volumes"):
        vwap([11], [9], [10], [float("inf")])


def test_support_resistance_and_fibonacci_reject_malformed_ohlc():
    with pytest.raises(ValueError, match="high"):
        support_resistance([8], [9])
    with pytest.raises(ValueError, match="high"):
        fibonacci_levels([8], [9])


def test_bollinger_zero_deviation_collapses_to_middle():
    result = bollinger([1.0, 2.0, 3.0], period=3, deviations=0)
    assert result["upper"] == result["middle"] == result["lower"] == 2.0


def test_macd_waits_for_signal_history():
    result = macd([float(i) for i in range(30)], fast=3, slow=5, signal=9)
    assert set(result) == {"macd"}
    assert math.isfinite(result["macd"])
