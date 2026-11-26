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


def test_future_candle_changes_do_not_rewrite_past_closed_trades():
    candles = sample_candles()
    cutoff_index = 100
    baseline = run_ema_backtest(candles)
    changed = list(candles)
    for index in range(cutoff_index, len(changed)):
        original = changed[index]
        shifted = float(original.close) * 1.12
        changed[index] = original.model_copy(update={
            "open": shifted, "high": shifted + 3, "low": shifted - 3,
            "close": shifted, "volume": original.volume,
        })
    revised = run_ema_backtest(changed)
    cutoff = candles[cutoff_index - 1].timestamp.isoformat()
    baseline_past = [trade for trade in baseline["trades"] if trade["exit_time"] <= cutoff]
    revised_past = [trade for trade in revised["trades"] if trade["exit_time"] <= cutoff]
    assert revised_past == baseline_past


def test_drawdown_uses_intrabar_low_not_only_candle_close():
    candles = sample_candles()
    baseline = run_ema_backtest(candles, fee_bps=0, slippage_bps=0)
    stressed = list(candles)
    # Add a deep intrabar adverse move during a period where the strategy is invested,
    # while leaving the close unchanged.
    index = 100
    candle = stressed[index]
    stressed[index] = candle.model_copy(update={"low": float(candle.close) * 0.70})
    result = run_ema_backtest(stressed, fee_bps=0, slippage_bps=0)
    assert result["max_drawdown_pct"] > baseline["max_drawdown_pct"]
    assert result["max_drawdown_at"] == stressed[index].timestamp.isoformat()
    assert "candle low" in result["drawdown_method"]


def test_drawdown_timestamp_is_null_when_no_drawdown_occurs():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    candles = [
        Candle(timestamp=start + timedelta(days=i), open=100+i, high=101+i,
               low=99+i, close=100+i, volume=100)
        for i in range(60)
    ]
    result = run_ema_backtest(candles)
    assert result["max_drawdown_pct"] >= 0
    if result["max_drawdown_pct"] == 0:
        assert result["max_drawdown_at"] is None


def test_backtest_reports_buy_and_hold_benchmark_with_matching_costs():
    candles = sample_candles()
    result = run_ema_backtest(candles, starting_capital=5000, fee_bps=10, slippage_bps=5, spread_bps=4)
    benchmark = result["benchmark"]
    assert benchmark["name"] == "Buy and hold"
    assert benchmark["final_equity"] > 0
    assert benchmark["entry_price"] > candles[0].open
    assert benchmark["excess_return_pct"] == pytest.approx(
        result["net_return_pct"] - benchmark["net_return_pct"], abs=0.0001)
    assert "same per-side cost" in benchmark["assumption"]


def test_backtest_reports_trade_expectancy_and_average_outcomes():
    result = run_ema_backtest(sample_candles())
    trades = result["trades"]
    if trades:
        assert result["expectancy_per_closed_trade"] == pytest.approx(
            sum(t["pnl"] for t in trades) / len(trades), abs=0.01)
    assert result["average_winning_trade"] is None or result["average_winning_trade"] > 0
    assert result["average_losing_trade"] is None or result["average_losing_trade"] < 0


def test_buy_and_hold_benchmark_reflects_transaction_costs():
    candles = sample_candles()
    free = run_ema_backtest(candles, fee_bps=0, slippage_bps=0)
    costly = run_ema_backtest(candles, fee_bps=20, slippage_bps=10)
    assert costly["benchmark"]["final_equity"] < free["benchmark"]["final_equity"]


def test_cost_sensitivity_reports_low_base_and_stressed_scenarios():
    from app.backtest import run_cost_sensitivity
    result = run_cost_sensitivity(sample_candles())
    scenarios = result["scenarios"]
    assert [item["name"] for item in scenarios] == ["low_cost", "base_cost", "stressed_cost"]
    assert result["cost_order_is_monotonic"] is True
    assert scenarios[0]["final_equity"] >= scenarios[1]["final_equity"] >= scenarios[2]["final_equity"]
    assert all("max_drawdown_pct" in item and "profit_factor" in item for item in scenarios)


def test_cost_sensitivity_rejects_duplicate_or_missing_scenario_names():
    from app.backtest import run_cost_sensitivity
    with pytest.raises(ValueError, match="unique"):
        run_cost_sensitivity(sample_candles(), scenarios=[
            {"name": "same", "fee_bps": 1, "slippage_bps": 1, "spread_bps": 1},
            {"name": "same", "fee_bps": 2, "slippage_bps": 2, "spread_bps": 2},
        ])


def test_cost_sensitivity_preserves_strategy_and_candle_input():
    from app.backtest import run_cost_sensitivity
    candles = sample_candles()
    before = [(c.timestamp, c.open, c.high, c.low, c.close) for c in candles]
    run_cost_sensitivity(candles)
    after = [(c.timestamp, c.open, c.high, c.low, c.close) for c in candles]
    assert after == before


def test_out_of_sample_uses_causal_warmup_and_test_period_benchmark():
    from app.backtest import run_out_of_sample_backtest
    candles = sample_candles()
    result = run_out_of_sample_backtest(candles, train_fraction=0.6)
    split = int(len(candles) * 0.6)
    assert result["train_candles"] == split
    assert result["test_candles"] == len(candles) - split
    assert result["split_time"] == candles[split].timestamp.isoformat()
    assert result["out_of_sample"]["evaluation_start_time"] == candles[split].timestamp.isoformat()
    assert result["out_of_sample"]["benchmark"]["assumption"].startswith(f"Buy at candle index {split}")
    assert "no parameter fitting" in result["method"]


def test_out_of_sample_does_not_allow_short_or_extreme_partitions():
    from app.backtest import run_out_of_sample_backtest
    with pytest.raises(ValueError, match="between 0.5 and 0.9"):
        run_out_of_sample_backtest(sample_candles(), train_fraction=0.95)
    with pytest.raises(ValueError, match="At least 120"):
        run_out_of_sample_backtest(sample_candles()[:100])


def test_start_index_rejects_invalid_boundaries():
    with pytest.raises(ValueError, match="start_index"):
        run_ema_backtest(sample_candles(), start_index=-1)
    with pytest.raises(ValueError, match="start_index"):
        run_ema_backtest(sample_candles(), start_index=len(sample_candles()) - 1)


def test_out_of_sample_metrics_are_independent_of_future_after_test_window():
    from app.backtest import run_out_of_sample_backtest
    candles = sample_candles()
    baseline = run_out_of_sample_backtest(candles, train_fraction=0.6)
    changed = list(candles)
    for i in range(110, len(changed)):
        c = changed[i]
        px = float(c.close) * 1.15
        changed[i] = c.model_copy(update={"open": px, "high": px + 3, "low": px - 3, "close": px})
    revised = run_out_of_sample_backtest(changed, train_fraction=0.6)
    # Signals/trades completed before the modified candles cannot be rewritten.
    cutoff = candles[109].timestamp.isoformat()
    before_a = [x for x in baseline["out_of_sample"].get("trades", []) if x["exit_time"] <= cutoff]
    before_b = [x for x in revised["out_of_sample"].get("trades", []) if x["exit_time"] <= cutoff]
    assert before_a == before_b


def _walk_forward_candles(count=300):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    result = []
    for i in range(count):
        # Deterministic alternating regimes create several EMA cross opportunities.
        trend = (i // 45 % 2) * 2 - 1
        price = 3000 + trend * (i % 45) * 2.2 + 0.8 * (i % 7)
        result.append(Candle(
            timestamp=start + timedelta(hours=i),
            open=price, high=price + 4, low=price - 4,
            close=price, volume=100,
        ))
    return result


def test_walk_forward_runs_multiple_chronological_non_overlapping_folds():
    from app.backtest import run_walk_forward_backtest
    candles = _walk_forward_candles()
    result = run_walk_forward_backtest(candles, initial_train_size=120, test_size=60)
    assert result["fold_count"] == 3
    assert result["total_test_candles"] == 180
    folds = result["folds"]
    for previous, current in zip(folds, folds[1:]):
        assert previous["test_end"] < current["test_start"]
        assert previous["test_candles"] == 60
        assert current["train_candles"] > previous["train_candles"]
    assert result["out_of_sample"]["total_closed_trades"] == sum(
        fold["test_closed_trades"] for fold in folds
    )


def test_walk_forward_compounds_fold_returns_and_benchmark_consistently():
    from app.backtest import run_walk_forward_backtest
    result = run_walk_forward_backtest(_walk_forward_candles(), initial_train_size=120, test_size=60)
    strategy_factor = 1.0
    benchmark_factor = 1.0
    for fold in result["folds"]:
        strategy_factor *= 1.0 + fold["test_net_return_pct"] / 100.0
        benchmark_factor *= 1.0 + fold["test_benchmark_return_pct"] / 100.0
    assert result["out_of_sample"]["compounded_return_pct"] == pytest.approx(
        (strategy_factor - 1.0) * 100.0, abs=0.0001
    )
    assert result["out_of_sample"]["compounded_benchmark_return_pct"] == pytest.approx(
        (benchmark_factor - 1.0) * 100.0, abs=0.0001
    )


def test_walk_forward_rejects_invalid_or_insufficient_windows():
    from app.backtest import run_walk_forward_backtest
    with pytest.raises(ValueError, match="at least 60"):
        run_walk_forward_backtest(_walk_forward_candles(), initial_train_size=50)
    with pytest.raises(ValueError, match="at least 20"):
        run_walk_forward_backtest(_walk_forward_candles(), test_size=10)
    with pytest.raises(ValueError, match="two complete"):
        run_walk_forward_backtest(_walk_forward_candles(150), initial_train_size=120, test_size=60)


def test_walk_forward_earlier_fold_is_independent_of_later_market_data():
    from app.backtest import run_walk_forward_backtest
    candles = _walk_forward_candles()
    baseline = run_walk_forward_backtest(candles, initial_train_size=120, test_size=60)
    changed = list(candles)
    for index in range(180, len(changed)):
        candle = changed[index]
        shifted = float(candle.close) * 1.10
        changed[index] = candle.model_copy(update={
            "open": shifted, "high": shifted + 4, "low": shifted - 4,
            "close": shifted,
        })
    revised = run_walk_forward_backtest(changed, initial_train_size=120, test_size=60)
    assert baseline["folds"][0] == revised["folds"][0]


def test_walk_forward_request_validates_minimum_history_and_costs():
    from app.backtest import WalkForwardRequest
    payload = WalkForwardRequest(candles=_walk_forward_candles(300))
    assert payload.initial_train_size == 120
    assert payload.test_size == 60
    with pytest.raises(ValidationError):
        WalkForwardRequest(candles=_walk_forward_candles(180))
    with pytest.raises(ValidationError):
        WalkForwardRequest(
            candles=_walk_forward_candles(300),
            initial_train_size=120,
            test_size=60,
            fee_bps=float("inf"),
        )
