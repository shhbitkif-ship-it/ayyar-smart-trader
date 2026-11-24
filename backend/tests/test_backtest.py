from datetime import datetime, timedelta, timezone
import pytest
from app.backtest import run_ema_backtest
from app.schemas import Candle


def sample_candles():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    closes = []
    for i in range(100):
        if i < 60:
            closes.append(3000 - i * 2)
        else:
            closes.append(2880 + (i - 60) * 4)
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
