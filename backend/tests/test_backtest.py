from datetime import datetime, timedelta, timezone
import pytest
from app.backtest import BacktestRequest, run_ema_backtest
from pydantic import ValidationError
from app.schemas import Candle


def sample_candles():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    closes = []
    for i in range(150):
        if i < 70:
            closes.append(3100 - i * 2)
        elif i < 110:
            closes.append(2960 + (i - 70) * 5)
        else:
            closes.append(3160 - (i - 110) * 5)
    return [Candle(timestamp=start + timedelta(days=i), open=price, high=price + 3, low=price - 3, close=price, volume=100) for i, price in enumerate(closes)]


def test_backtest_uses_next_candle_and_returns_metrics():
    result = run_ema_backtest(sample_candles())
    assert result["strategy"] == "EMA20/EMA50 long-only crossover"
    assert result["execution"].startswith("Signal confirmed at candle close")
    assert result["closed_trades"] >= 1
    assert "max_drawdown_pct" in result
    assert result["starting_capital"] == 10000.0
    assert result["warning"].startswith("Research only")


def test_spread_cost_reduces_result_and_is_reported_per_side():
    candles = sample_candles()
    no_spread = run_ema_backtest(candles, fee_bps=0, slippage_bps=0, spread_bps=0)
    with_spread = run_ema_backtest(candles, fee_bps=0, slippage_bps=0, spread_bps=20)
    assert with_spread["final_equity"] < no_spread["final_equity"]
    assert with_spread["cost_model"]["spread_bps_full"] == 20
    assert with_spread["cost_model"]["spread_bps_per_side"] == 10


def test_transaction_costs_reduce_result():
    candles = sample_candles()
    free = run_ema_backtest(candles, fee_bps=0, slippage_bps=0)
    costly = run_ema_backtest(candles, fee_bps=20, slippage_bps=10)
    assert costly["final_equity"] < free["final_equity"]


def test_backtest_rejects_insufficient_history():
    with pytest.raises(ValueError):
        run_ema_backtest(sample_candles()[:59])


def test_open_position_final_equity_includes_estimated_exit_costs():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    prices = [3100 - i * 2 if i < 70 else 2960 + (i - 70) * 5 for i in range(120)]
    rising = [Candle(timestamp=start + timedelta(days=i), open=price, high=price + 3, low=price - 3, close=price, volume=100) for i, price in enumerate(prices)]
    no_cost = run_ema_backtest(rising, fee_bps=0, slippage_bps=0)
    with_cost = run_ema_backtest(rising, fee_bps=10, slippage_bps=5)
    assert no_cost["open_position"] is True
    assert with_cost["open_position"] is True
    assert with_cost["final_equity"] < no_cost["final_equity"]
    assert with_cost["equity_curve"][-1]["equity"] == with_cost["final_equity"]
    assert any(costly_point["equity"] < free_point["equity"] for free_point, costly_point in zip(no_cost["equity_curve"], with_cost["equity_curve"]) if free_point["equity"] > no_cost["starting_capital"])


def test_equity_curve_marks_every_candle_for_drawdown_accuracy():
    candles = sample_candles()
    result = run_ema_backtest(candles)
    assert len(result["equity_curve"]) == len(candles)
    assert result["equity_curve"][0]["timestamp"] == candles[0].timestamp.isoformat()
    assert result["equity_curve"][-1]["timestamp"] == candles[-1].timestamp.isoformat()


@pytest.mark.parametrize("field,bad_value", [
    ("starting_capital", float("nan")), ("starting_capital", float("inf")),
    ("fee_bps", float("nan")), ("slippage_bps", float("inf")),
])
def test_backtest_request_rejects_non_finite_parameters(field, bad_value):
    values = {"candles": sample_candles()}
    values[field] = bad_value
    with pytest.raises(ValidationError):
        BacktestRequest(**values)


@pytest.mark.parametrize("field,bad_value", [
    ("starting_capital", float("inf")), ("fee_bps", float("nan")), ("slippage_bps", float("-inf")),
])
def test_backtest_engine_rejects_non_finite_parameters(field, bad_value):
    with pytest.raises(ValueError, match="finite"):
        run_ema_backtest(sample_candles(), **{field: bad_value})


def test_backtest_rejects_duplicate_candle_timestamps():
    candles = sample_candles()
    candles[1] = candles[0].model_copy(update={"close": candles[0].close})
    with pytest.raises(ValueError, match="timestamps"):
        run_ema_backtest(candles)


def test_backtest_rejects_out_of_order_input_instead_of_silently_sorting():
    candles = sample_candles()
    candles[10], candles[11] = candles[11], candles[10]
    with pytest.raises(ValueError, match="input order"):
        run_ema_backtest(candles)


def test_backtest_rejects_timezone_naive_timestamps():
    candles = sample_candles()
    candles[0] = candles[0].model_copy(update={"timestamp": datetime(2025, 1, 1)})
    with pytest.raises(ValueError, match="timezone-aware"):
        run_ema_backtest(candles)
