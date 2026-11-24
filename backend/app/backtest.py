from __future__ import annotations

from typing import Sequence
from .schemas import Candle
from .indicators import ema


def run_ema_backtest(
    candles: Sequence[Candle],
    *,
    starting_capital: float = 10000.0,
    fee_bps: float = 10.0,
    slippage_bps: float = 5.0,
) -> dict:
    """Long-only EMA20/EMA50 close-confirmed strategy, filled at next candle open.

    This is a research simulation, not a live signal. Costs are charged on both
    entry and exit. No leverage, funding, taxes, or broker-specific lot rules.
    """
    ordered = sorted(candles, key=lambda c: c.timestamp)
    if len(ordered) < 60:
        raise ValueError("At least 60 OHLC candles are required.")
    if starting_capital <= 0 or fee_bps < 0 or slippage_bps < 0:
        raise ValueError("Capital must be positive and costs cannot be negative.")

    closes = [float(c.close) for c in ordered]
    fast, slow = ema(closes, 20), ema(closes, 50)
    # Align EMA20 with EMA50; both arrays start after their own warm-up.
    offset = 50 - 20
    fast_aligned = fast[offset:]
    if len(fast_aligned) != len(slow):
        raise ValueError("Indicator alignment failed.")

    cost_rate = (fee_bps + slippage_bps) / 10000.0
    cash = float(starting_capital)
    quantity = 0.0
    entry_price = None
    entry_time = None
    trades = []
    equity_curve = [{"timestamp": ordered[0].timestamp.isoformat(), "equity": round(cash, 2)}]

    for i in range(1, len(slow)):
        prev_up = fast_aligned[i - 1] > slow[i - 1]
        now_up = fast_aligned[i] > slow[i]
        crossed_up = not prev_up and now_up
        crossed_down = prev_up and not now_up
        fill_index = i + 50  # slow[0] corresponds to candle index 49; i is current close index.
        if fill_index >= len(ordered):
            break
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

        mark_index = min(fill_index, len(ordered) - 1)
        equity = cash if quantity == 0 else quantity * float(ordered[mark_index].close)
        equity_curve.append({
            "timestamp": ordered[mark_index].timestamp.isoformat(),
            "equity": round(equity, 2),
        })

    final_equity = cash if quantity == 0 else quantity * float(ordered[-1].close)
    if quantity > 0 and entry_price is not None:
        unrealized = final_equity - quantity * entry_price
    else:
        unrealized = 0.0
    returns = [t["return_pct"] for t in trades]
    wins = sum(1 for t in trades if t["pnl"] > 0)
    peak = float(starting_capital)
    max_drawdown = 0.0
    for point in equity_curve:
        peak = max(peak, point["equity"])
        if peak > 0:
            max_drawdown = max(max_drawdown, (peak - point["equity"]) / peak)

    gross_profit = sum(t["pnl"] for t in trades if t["pnl"] > 0)
    gross_loss = abs(sum(t["pnl"] for t in trades if t["pnl"] < 0))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else (None if gross_profit == 0 else "infinity")
    return {
        "strategy": "EMA20/EMA50 long-only crossover",
        "execution": "Signal confirmed at candle close; orders filled at next candle open",
        "cost_model": {"fee_bps_per_side": fee_bps, "slippage_bps_per_side": slippage_bps},
        "starting_capital": round(starting_capital, 2),
        "final_equity": round(final_equity, 2),
        "net_return_pct": round((final_equity / starting_capital - 1.0) * 100.0, 4),
        "max_drawdown_pct": round(max_drawdown * 100.0, 4),
        "closed_trades": len(trades),
        "win_rate_pct": round((wins / len(trades)) * 100.0, 2) if trades else 0.0,
        "profit_factor": round(profit_factor, 4) if isinstance(profit_factor, float) else profit_factor,
        "open_position": quantity > 0,
        "unrealized_pnl": round(unrealized, 2),
        "trades": trades,
        "equity_curve": equity_curve,
        "warning": "Research only. Results depend on candle quality and assumptions; excludes taxes, funding, market impact, gaps beyond next-open fills, and broker constraints. Not a trading recommendation.",
    }
