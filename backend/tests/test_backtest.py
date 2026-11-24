from datetime import datetime, timedelta, timezone
import pytest
from app.backtest import run_ema_backtest
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
    return [
        Candle(
            timestamp=start + timedelta(days=i),
            open=price,
            high=price + 3,
            low=price - 3,
            close=price,
            volume=100,
        )
        for i, price in enumerate(closes)
    ]


def test_backtest_uses_next_candle_and_returns_metrics():
    result = run_ema_backtest(sample_candles())
    assert result["strategy"] == "EMA20/EMA50 long-only crossover"
    assert result["execution"].startswith("Signal confirmed at candle close")
    assert result["closed_trades"] >= 1
    assert "max_drawdown_pct" in result
    assert result["starting_capital"] == 10000.0
    assert result["warning"].startswith("Research only")


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
    rising = [
        Candle(
            timestamp=start + timedelta(days=i),
            open=100 + i,
            high=102 + i,
            low=99 + i,
            close=101 + i,
            volume=100,
        )
        for i in range(120)
    ]
    no_cost = run_ema_backtest(rising, fee_bps=0, slippage_bps=0)
    with_cost = run_ema_backtest(rising, fee_bps=10, slippage_bps=5)
    assert no_cost["open_position"] is True
    assert with_cost["open_position"] is True
    assert with_cost["final_equity"] < no_cost["final_equity"]
    assert with_cost["equity_curve"][-1]["equity"] == with_cost["final_equity"]
    assert any(
        costly_point["equity"] < free_point["equity"]
        for free_point, costly_point in zip(no_cost["equity_curve"], with_cost["equity_curve"])
        if free_point["equity"] > no_cost["starting_capital"]
    )


def test_equity_curve_marks_every_candle_for_drawdown_accuracy():
    candles = sample_candles()
    result = run_ema_backtest(candles)
    assert len(result["equity_curve"]) == len(candles)
    assert result["equity_curve"][0]["timestamp"] == candles[0].timestamp.isoformat()
    assert result["equity_curve"][-1]["timestamp"] == candles[-1].timestamp.isoformat()
