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
    equity_curve = [{"timestamp": ordered[0].timestamp.isoformat(), "equity": round(cash, 2)}]
    # Intrabar adverse marks make drawdown more conservative than close-only marks.
    drawdown_curve = [{"timestamp": ordered[0].timestamp.isoformat(), "equity": cash}]

    for fill_index in range(1, len(ordered)):
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
    for point in drawdown_curve:
        peak = max(peak, point["equity"])
        if peak > 0:
            drawdown = (peak - point["equity"]) / peak
            if drawdown > max_drawdown:
                max_drawdown = drawdown
                max_drawdown_at = point["timestamp"]
    gross_profit = sum(t["pnl"] for t in trades if t["pnl"] > 0)
    gross_loss = abs(sum(t["pnl"] for t in trades if t["pnl"] < 0))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else (None if gross_profit == 0 else "infinity")
    return {
        "strategy": "EMA20/EMA50 long-only crossover",
        "execution": "Signal confirmed at candle close; orders filled at next candle open",
        "cost_model": {"fee_bps_per_side": fee_bps, "slippage_bps_per_side": slippage_bps, "spread_bps_full": spread_bps, "spread_bps_per_side": spread_bps / 2.0},
        "starting_capital": round(starting_capital, 2),
        "final_equity": round(final_equity, 2),
        "net_return_pct": round((final_equity / starting_capital - 1.0) * 100.0, 4),
        "max_drawdown_pct": round(max_drawdown * 100.0, 4),
        "max_drawdown_at": max_drawdown_at,
        "drawdown_method": "Intrabar adverse mark at candle low for open long positions, including estimated exit costs.",
        "closed_trades": len(trades),
        "win_rate_pct": round((wins / len(trades)) * 100.0, 2) if trades else 0.0,
        "profit_factor": round(profit_factor, 4) if isinstance(profit_factor, float) else profit_factor,
        "open_position": quantity > 0,
        "unrealized_pnl": round(unrealized, 2),
        "trades": trades,
        "equity_curve": equity_curve,
        "warning": "Research only. Results depend on candle quality and assumptions; excludes taxes, funding, market impact, gaps beyond next-open fills, and broker constraints. Not a trading recommendation.",
    }


def backtest(payload: BacktestRequest) -> dict:
    return run_ema_backtest(payload.candles, starting_capital=payload.starting_capital, fee_bps=payload.fee_bps, slippage_bps=payload.slippage_bps, spread_bps=payload.spread_bps)
