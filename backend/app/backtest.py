from __future__ import annotations

from typing import Sequence, Literal
import math
from pydantic import BaseModel, Field, model_validator
from .schemas import Candle
from .indicators import ema


class BacktestRequest(BaseModel):
    candles: list[Candle] = Field(min_length=60, max_length=5000)
    timeframe: Literal["1m", "5m", "15m", "30m", "1h", "4h", "1d"] = "15m"
    starting_capital: float = Field(default=10000.0, gt=0)
    fee_bps: float = Field(default=10.0, ge=0, le=500)
    slippage_bps: float = Field(default=5.0, ge=0, le=500)
    spread_bps: float = Field(default=0.0, ge=0, le=500, description="Full quoted bid/ask spread; half is charged per side.")

    @model_validator(mode="after")
    def validate_finite_parameters(self):
        for name in ("starting_capital", "fee_bps", "slippage_bps", "spread_bps"):
            if not math.isfinite(getattr(self, name)):
                raise ValueError(f"{name} must be finite")
        return self


def run_ema_backtest(
    candles: Sequence[Candle],
    *,
    starting_capital: float = 10000.0,
    fee_bps: float = 10.0,
    slippage_bps: float = 5.0,
    spread_bps: float = 0.0,
    start_index: int = 0,
) -> dict:
    """Long-only EMA20/EMA50 close-confirmed strategy, filled at next candle open.

    Research simulation only. Input order and timezone-aware timestamps are
    strictly validated; endpoint callers must additionally pass a CLEAN
    timeframe continuity audit before invoking this calculation.
    """
    for name, value in (("starting_capital", starting_capital), ("fee_bps", fee_bps), ("slippage_bps", slippage_bps), ("spread_bps", spread_bps)):
        if not math.isfinite(value):
            raise ValueError(f"{name} must be finite.")
    ordered = list(candles)
    if any(c.timestamp.tzinfo is None or c.timestamp.utcoffset() is None for c in ordered):
        raise ValueError("Candle timestamps must be timezone-aware.")
    if any(ordered[i].timestamp >= ordered[i + 1].timestamp for i in range(len(ordered) - 1)):
        raise ValueError("Candle timestamps must be unique and strictly increasing in input order.")
    if len(ordered) < 60:
        raise ValueError("At least 60 OHLC candles are required.")
    if isinstance(start_index, bool) or not isinstance(start_index, int) or start_index < 0 or start_index >= len(ordered) - 1:
        raise ValueError("start_index must identify a candle with at least one following fill candle.")
    if starting_capital <= 0 or fee_bps < 0 or slippage_bps < 0 or spread_bps < 0 or fee_bps > 500 or slippage_bps > 500 or spread_bps > 500:
        raise ValueError("Capital must be positive and costs cannot be negative.")

    closes = [float(c.close) for c in ordered]
    fast, slow = ema(closes, 20), ema(closes, 50)
    offset = 50 - 20
    fast_aligned = fast[offset:]
    if len(fast_aligned) != len(slow):
        raise ValueError("Indicator alignment failed.")

    cost_rate = (fee_bps + slippage_bps + spread_bps / 2.0) / 10000.0
    cash = float(starting_capital)
    quantity = 0.0
    entry_price = None
    entry_time = None
    trades = []
    equity_curve = [{"timestamp": ordered[start_index].timestamp.isoformat(), "equity": round(cash, 2)}]
    # Intrabar adverse marks make drawdown more conservative than close-only marks.
    drawdown_curve = [{"timestamp": ordered[start_index].timestamp.isoformat(), "equity": cash}]

    for fill_index in range(start_index + 1, len(ordered)):
        signal_index = fill_index - 1
        if signal_index >= 50:
            ema_index = signal_index - 49
            if ema_index >= 1:
                prev_up = fast_aligned[ema_index - 1] > slow[ema_index - 1]
                now_up = fast_aligned[ema_index] > slow[ema_index]
                crossed_up = not prev_up and now_up
                crossed_down = prev_up and not now_up
                fill = float(ordered[fill_index].open)
                if crossed_down and quantity > 0:
                    exit_price = fill * (1.0 - cost_rate)
                    proceeds = quantity * exit_price
                    pnl = proceeds - (quantity * entry_price)
                    cash = proceeds
                    trades.append({
                        "entry_time": entry_time,
                        "exit_time": ordered[fill_index].timestamp.isoformat(),
                        "entry_price": round(entry_price, 6),
                        "exit_price": round(exit_price, 6),
                        "pnl": round(pnl, 2),
                        "return_pct": round((exit_price / entry_price - 1.0) * 100.0, 4),
                    })
                    quantity = 0.0
                    entry_price = None
                    entry_time = None
                elif crossed_up and quantity == 0:
                    entry_price = fill * (1.0 + cost_rate)
                    quantity = cash / entry_price
                    cash = 0.0
                    entry_time = ordered[fill_index].timestamp.isoformat()

        marked_equity = cash if quantity == 0 else quantity * float(ordered[fill_index].close) * (1.0 - cost_rate)
        equity_curve.append({"timestamp": ordered[fill_index].timestamp.isoformat(), "equity": round(marked_equity, 2)})
        adverse_equity = cash if quantity == 0 else quantity * float(ordered[fill_index].low) * (1.0 - cost_rate)
        drawdown_curve.append({"timestamp": ordered[fill_index].timestamp.isoformat(), "equity": adverse_equity})

    if quantity > 0:
        liquidation_price = float(ordered[-1].close) * (1.0 - cost_rate)
        final_equity = quantity * liquidation_price
        equity_curve[-1]["equity"] = round(final_equity, 2)
        unrealized = final_equity - quantity * entry_price
    else:
        final_equity = cash
        unrealized = 0.0
    wins = sum(1 for t in trades if t["pnl"] > 0)
    peak = float(starting_capital)
    max_drawdown = 0.0
    max_drawdown_at = None
    for close_point, adverse_point in zip(equity_curve, drawdown_curve):
        # Use close-marked equity for the running peak and intrabar low for the trough.
        peak = max(peak, close_point["equity"])
        if peak > 0:
            drawdown = (peak - adverse_point["equity"]) / peak
            if drawdown > max_drawdown:
                max_drawdown = drawdown
                max_drawdown_at = adverse_point["timestamp"]
    gross_profit = sum(t["pnl"] for t in trades if t["pnl"] > 0)
    gross_loss = abs(sum(t["pnl"] for t in trades if t["pnl"] < 0))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else (None if gross_profit == 0 else "infinity")
    losing_trades = [t["pnl"] for t in trades if t["pnl"] < 0]
    winning_trades = [t["pnl"] for t in trades if t["pnl"] > 0]
    average_win = sum(winning_trades) / len(winning_trades) if winning_trades else None
    average_loss = sum(losing_trades) / len(losing_trades) if losing_trades else None
    expectancy = sum(t["pnl"] for t in trades) / len(trades) if trades else None
    benchmark_entry = float(ordered[start_index].open) * (1.0 + cost_rate)
    benchmark_quantity = starting_capital / benchmark_entry
    benchmark_final = benchmark_quantity * float(ordered[-1].close) * (1.0 - cost_rate)
    benchmark_return = (benchmark_final / starting_capital - 1.0) * 100.0
    strategy_return = (final_equity / starting_capital - 1.0) * 100.0
    return {
        "strategy": "EMA20/EMA50 long-only crossover",
        "execution": "Signal confirmed at candle close; orders filled at next candle open",
        "cost_model": {"fee_bps_per_side": fee_bps, "slippage_bps_per_side": slippage_bps, "spread_bps_full": spread_bps, "spread_bps_per_side": spread_bps / 2.0},
        "starting_capital": round(starting_capital, 2),
        "evaluation_start_index": start_index,
        "evaluation_start_time": ordered[start_index].timestamp.isoformat(),
        "final_equity": round(final_equity, 2),
        "net_return_pct": round(strategy_return, 4),
        "benchmark": {
            "name": "Buy and hold",
            "entry_price": round(benchmark_entry, 6),
            "final_equity": round(benchmark_final, 2),
            "net_return_pct": round(benchmark_return, 4),
            "excess_return_pct": round(strategy_return - benchmark_return, 4),
            "assumption": f"Buy at candle index {start_index} open and liquidate at final candle close with the same per-side cost assumptions.",
        },
        "max_drawdown_pct": round(max_drawdown * 100.0, 4),
        "max_drawdown_at": max_drawdown_at,
        "drawdown_method": "Intrabar adverse mark at candle low for open long positions, including estimated exit costs.",
        "closed_trades": len(trades),
        "win_rate_pct": round((wins / len(trades)) * 100.0, 2) if trades else 0.0,
        "profit_factor": round(profit_factor, 4) if isinstance(profit_factor, float) else profit_factor,
        "average_winning_trade": round(average_win, 2) if average_win is not None else None,
        "average_losing_trade": round(average_loss, 2) if average_loss is not None else None,
        "expectancy_per_closed_trade": round(expectancy, 2) if expectancy is not None else None,
        "open_position": quantity > 0,
        "unrealized_pnl": round(unrealized, 2),
        "trades": trades,
        "equity_curve": equity_curve,
        "warning": "Research only. Results depend on candle quality and assumptions; excludes taxes, funding, market impact, gaps beyond next-open fills, and broker constraints. Not a trading recommendation.",
    }


def backtest(payload: BacktestRequest) -> dict:
    return run_ema_backtest(payload.candles, starting_capital=payload.starting_capital, fee_bps=payload.fee_bps, slippage_bps=payload.slippage_bps, spread_bps=payload.spread_bps)


def run_cost_sensitivity(
    candles: Sequence[Candle],
    *,
    starting_capital: float = 10000.0,
    scenarios: Sequence[dict] | None = None,
) -> dict:
    """Re-run the same strategy under progressively different execution costs.

    This is a robustness diagnostic, not parameter optimization. Scenarios are
    explicit and independently validated by run_ema_backtest.
    """
    selected = scenarios or (
        {"name": "low_cost", "fee_bps": 2.0, "slippage_bps": 1.0, "spread_bps": 2.0},
        {"name": "base_cost", "fee_bps": 10.0, "slippage_bps": 5.0, "spread_bps": 6.0},
        {"name": "stressed_cost", "fee_bps": 20.0, "slippage_bps": 15.0, "spread_bps": 20.0},
    )
    if not selected:
        raise ValueError("At least one cost scenario is required.")
    results = []
    names = set()
    for scenario in selected:
        if not isinstance(scenario, dict):
            raise ValueError("Each cost scenario must be a mapping.")
        name = scenario.get("name")
        if not isinstance(name, str) or not name.strip() or name in names:
            raise ValueError("Scenario names must be non-empty and unique.")
        names.add(name)
        result = run_ema_backtest(
            candles,
            starting_capital=starting_capital,
            fee_bps=scenario.get("fee_bps", 10.0),
            slippage_bps=scenario.get("slippage_bps", 5.0),
            spread_bps=scenario.get("spread_bps", 0.0),
        )
        results.append({
            "name": name,
            "fee_bps_per_side": scenario.get("fee_bps", 10.0),
            "slippage_bps_per_side": scenario.get("slippage_bps", 5.0),
            "spread_bps_full": scenario.get("spread_bps", 0.0),
            "final_equity": result["final_equity"],
            "net_return_pct": result["net_return_pct"],
            "max_drawdown_pct": result["max_drawdown_pct"],
            "closed_trades": result["closed_trades"],
            "profit_factor": result["profit_factor"],
        })
    ordered_costs = [
        item["fee_bps_per_side"] + item["slippage_bps_per_side"] + item["spread_bps_full"] / 2
        for item in results
    ]
    monotonic_cost_order = all(
        ordered_costs[i] <= ordered_costs[i + 1]
        for i in range(len(ordered_costs) - 1)
    )
    return {
        "diagnostic": "Execution-cost sensitivity; not an optimization result.",
        "scenarios": results,
        "cost_order_is_monotonic": monotonic_cost_order,
        "warning": "Higher assumed costs should not improve comparable results; scenarios are listed in caller-supplied order.",
    }


def run_out_of_sample_backtest(
    candles: Sequence[Candle],
    *,
    train_fraction: float = 0.70,
    starting_capital: float = 10000.0,
    fee_bps: float = 10.0,
    slippage_bps: float = 5.0,
    spread_bps: float = 0.0,
) -> dict:
    """Evaluate fixed EMA rules on a chronological holdout without fitting."""
    if not math.isfinite(train_fraction) or not 0.5 <= train_fraction <= 0.9:
        raise ValueError("train_fraction must be finite and between 0.5 and 0.9.")
    ordered = list(candles)
    if len(ordered) < 120:
        raise ValueError("At least 120 candles are required for 60-candle train and test segments.")
    split_index = int(len(ordered) * train_fraction)
    if split_index < 60 or len(ordered) - split_index < 60:
        raise ValueError("Train and test segments must each contain at least 60 candles.")
    train = run_ema_backtest(
        ordered[:split_index], starting_capital=starting_capital,
        fee_bps=fee_bps, slippage_bps=slippage_bps, spread_bps=spread_bps,
    )
    # Keep pre-test candles solely as causal indicator warmup. Trading and the
    # benchmark both begin at the first test candle, with fresh test capital.
    test = run_ema_backtest(
        ordered, starting_capital=starting_capital,
        fee_bps=fee_bps, slippage_bps=slippage_bps, spread_bps=spread_bps,
        start_index=split_index,
    )
    return {
        "method": "Chronological holdout; fixed EMA20/EMA50 rules; no parameter fitting.",
        "train_fraction": train_fraction,
        "train_candles": split_index,
        "test_candles": len(ordered) - split_index,
        "split_time": ordered[split_index].timestamp.isoformat(),
        "train": {
            "net_return_pct": train["net_return_pct"],
            "max_drawdown_pct": train["max_drawdown_pct"],
            "closed_trades": train["closed_trades"],
            "profit_factor": train["profit_factor"],
            "expectancy_per_closed_trade": train["expectancy_per_closed_trade"],
        },
        "out_of_sample": {
            "net_return_pct": test["net_return_pct"],
            "final_equity": test["final_equity"],
            "max_drawdown_pct": test["max_drawdown_pct"],
            "closed_trades": test["closed_trades"],
            "profit_factor": test["profit_factor"],
            "expectancy_per_closed_trade": test["expectancy_per_closed_trade"],
            "benchmark": test["benchmark"],
            "open_position": test["open_position"],
            "unrealized_pnl": test["unrealized_pnl"],
            "trades": test["trades"],
            "evaluation_start_time": test["evaluation_start_time"],
        },
        "leakage_controls": [
            "Chronological split; no random shuffling.",
            "Test indicators use only candles available at or before each signal.",
            "No strategy parameters are optimized on train or test data.",
            "Test trading and buy-and-hold benchmark both start at the test boundary.",
        ],
        "warning": "A single holdout is not proof of future profitability. Validate across multiple instruments, regimes, and rolling periods before live use.",
    }




class WalkForwardRequest(BaseModel):
    candles: list[Candle] = Field(min_length=120, max_length=5000)
    timeframe: Literal["1m", "5m", "15m", "30m", "1h", "4h", "1d"] = "15m"
    initial_train_size: int = Field(default=120, ge=60, le=4000)
    test_size: int = Field(default=60, ge=20, le=2000)
    starting_capital: float = Field(default=10000.0, gt=0)
    fee_bps: float = Field(default=10.0, ge=0, le=500)
    slippage_bps: float = Field(default=5.0, ge=0, le=500)
    spread_bps: float = Field(default=0.0, ge=0, le=500)

    @model_validator(mode="after")
    def validate_walk_forward_request(self):
        if len(self.candles) < self.initial_train_size + 2 * self.test_size:
            raise ValueError("At least two complete test windows are required after the initial training history.")
        for name in ("starting_capital", "fee_bps", "slippage_bps", "spread_bps"):
            if not math.isfinite(getattr(self, name)):
                raise ValueError(f"{name} must be finite")
        return self


def run_walk_forward_backtest(
    candles: Sequence[Candle],
    *,
    initial_train_size: int = 120,
    test_size: int = 60,
    starting_capital: float = 10000.0,
    fee_bps: float = 10.0,
    slippage_bps: float = 5.0,
    spread_bps: float = 0.0,
) -> dict:
    """Run sequential, non-overlapping holdout windows with expanding history.

    EMA20/EMA50 parameters remain fixed. Each fold's training report uses only
    candles preceding that fold; the test fold is evaluated once and never
    used to alter strategy parameters. Capital is reset and positions are
    force-liquidated at each fold boundary for comparable independent returns.
    """
    if isinstance(initial_train_size, bool) or not isinstance(initial_train_size, int) or initial_train_size < 60:
        raise ValueError("initial_train_size must be an integer of at least 60.")
    if isinstance(test_size, bool) or not isinstance(test_size, int) or test_size < 20:
        raise ValueError("test_size must be an integer of at least 20.")
    ordered = list(candles)
    if len(ordered) < initial_train_size + 2 * test_size:
        raise ValueError("At least two complete test windows are required after the initial training history.")
    folds = []
    compounded_strategy = 1.0
    compounded_benchmark = 1.0
    total_closed_trades = 0
    test_start = initial_train_size
    fold_number = 1
    while test_start < len(ordered):
        test_end = min(test_start + test_size, len(ordered))
        if test_end - test_start < 20:
            break
        history = ordered[:test_start]
        training = run_ema_backtest(
            history, starting_capital=starting_capital,
            fee_bps=fee_bps, slippage_bps=slippage_bps, spread_bps=spread_bps,
        )
        evaluation = run_ema_backtest(
            ordered[:test_end], starting_capital=starting_capital,
            fee_bps=fee_bps, slippage_bps=slippage_bps, spread_bps=spread_bps,
            start_index=test_start,
        )
        strategy_factor = evaluation["final_equity"] / starting_capital
        benchmark_factor = evaluation["benchmark"]["final_equity"] / starting_capital
        compounded_strategy *= strategy_factor
        compounded_benchmark *= benchmark_factor
        total_closed_trades += evaluation["closed_trades"]
        folds.append({
            "fold": fold_number,
            "train_start": ordered[0].timestamp.isoformat(),
            "train_end": ordered[test_start - 1].timestamp.isoformat(),
            "test_start": ordered[test_start].timestamp.isoformat(),
            "test_end": ordered[test_end - 1].timestamp.isoformat(),
            "train_candles": test_start,
            "test_candles": test_end - test_start,
            "train_net_return_pct": training["net_return_pct"],
            "test_net_return_pct": evaluation["net_return_pct"],
            "test_max_drawdown_pct": evaluation["max_drawdown_pct"],
            "test_closed_trades": evaluation["closed_trades"],
            "test_profit_factor": evaluation["profit_factor"],
            "test_expectancy_per_closed_trade": evaluation["expectancy_per_closed_trade"],
            "test_benchmark_return_pct": evaluation["benchmark"]["net_return_pct"],
            "test_excess_return_pct": evaluation["benchmark"]["excess_return_pct"],
            "test_trades": evaluation["trades"],
        })
        fold_number += 1
        test_start = test_end
    if len(folds) < 2:
        raise ValueError("At least two valid out-of-sample windows are required.")
    returns = [fold["test_net_return_pct"] for fold in folds]
    drawdowns = [fold["test_max_drawdown_pct"] for fold in folds]
    return {
        "method": "Expanding-window walk-forward; chronological non-overlapping tests; fixed EMA20/EMA50 parameters; no tuning.",
        "initial_train_size": initial_train_size,
        "test_size": test_size,
        "fold_count": len(folds),
        "total_test_candles": sum(fold["test_candles"] for fold in folds),
        "unused_trailing_candles": len(ordered) - initial_train_size - sum(fold["test_candles"] for fold in folds),
        "out_of_sample": {
            "compounded_return_pct": round((compounded_strategy - 1.0) * 100.0, 4),
            "compounded_benchmark_return_pct": round((compounded_benchmark - 1.0) * 100.0, 4),
            "excess_compounded_return_pct": round((compounded_strategy - compounded_benchmark) * 100.0, 4),
            "worst_fold_drawdown_pct": round(max(drawdowns), 4),
            "average_fold_return_pct": round(sum(returns) / len(returns), 4),
            "total_closed_trades": total_closed_trades,
        },
        "folds": folds,
        "leakage_controls": [
            "Each training window ends before its corresponding test window.",
            "Test windows are chronological and do not overlap.",
            "EMA parameters are fixed; no optimization or selection uses test results.",
            "Each test uses only prior candles for indicator warmup.",
            "Strategy and benchmark are both reset and liquidated at each test-window boundary.",
        ],
        "warning": "Fold returns compound under an explicit reset-and-liquidate assumption. This is a research diagnostic, not a continuous portfolio simulation or evidence of future profitability.",
    }
