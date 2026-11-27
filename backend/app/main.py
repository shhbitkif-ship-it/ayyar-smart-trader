from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from .engine import evaluate
from .schemas import EvaluateRequest, SignalResponse
from .market_data import market_snapshot
from .config import DEFAULT_RISK_PER_TRADE, MAX_DAILY_LOSS, MAX_DRAWDOWN
from .risk import PositionSizeRequest, calculate_position_size, TradePlanRequest, validate_trade_plan, AtrTradePlanRequest, build_atr_trade_plan
from .backtest import BacktestRequest, WalkForwardRequest, backtest, run_walk_forward_backtest
from .historical_quality import CandleQualityRequest, inspect_candle_series

app = FastAPI(
    title="Ayyar Smart Trader API",
    version="0.4.0",
    description="Iran and global gold market data with source timestamps, stale-data protection and conservative signal evaluation.",
)


@app.get("/health")
def health():
    return {"status": "ok", "service": "ayyar-smart-trader-api", "version": "0.4.0"}


@app.get("/v1/market/status")
async def market_status():
    snapshot = await market_snapshot()
    return {
        "status": snapshot["status"],
        "as_of": snapshot["as_of"],
        "live_quotes": sum(1 for q in snapshot["quotes"] if q["status"] == "LIVE"),
        "total_quotes": len(snapshot["quotes"]),
        "attribution": snapshot["attribution"],
    }


@app.get("/v1/market/quotes")
async def market_quotes():
    return await market_snapshot()


@app.get("/v1/risk/policy")
def risk_policy():
    return {
        "default_risk_per_trade": DEFAULT_RISK_PER_TRADE,
        "max_daily_loss": MAX_DAILY_LOSS,
        "max_drawdown": MAX_DRAWDOWN,
        "execution_enabled": False,
        "note": "Risk limits are policy defaults; broker-specific sizing and execution remain disabled until instrument specifications are verified.",
    }


@app.post("/v1/risk/position-size")
def position_size(payload: PositionSizeRequest):
    return calculate_position_size(payload)


@app.post("/v1/risk/validate-trade-plan")
def validate_plan(payload: TradePlanRequest):
    return validate_trade_plan(payload)


@app.post("/v1/risk/atr-trade-plan")
def atr_trade_plan(payload: AtrTradePlanRequest):
    return build_atr_trade_plan(payload)


SIGNAL_QUOTE_SYMBOLS = {
    "XAUUSD": "XAUUSD",
    "GOLD18": "GOLD18",
    "GOLD24": "GOLD24",
    "MESGHAL": "MESGHAL",
    "COIN_EMAMI": "COIN_EMAMI",
    "COIN_HALF": "COIN_HALF",
    "COIN_QUARTER": "COIN_QUARTER",
}


@app.post("/v1/signals/evaluate", response_model=SignalResponse)
async def evaluate_signal(payload: EvaluateRequest):
    # Signal generation is fail-closed: the server, not the caller, verifies
    # that the corresponding live reference quote has multi-source consensus.
    snapshot = await market_snapshot()
    quote_symbol = SIGNAL_QUOTE_SYMBOLS.get(payload.symbol.upper())
    quote = next(
        (item for item in snapshot.get("quotes", [])
         if item.get("symbol") == quote_symbol),
        None,
    ) if quote_symbol else None
    meta = quote.get("meta") if isinstance(quote, dict) else {}
    meta = meta if isinstance(meta, dict) else {}
    source_quality = meta.get("source_quality", "UNKNOWN")
    sources = meta.get("sources")
    spread_pct = meta.get("spread_pct")
    quality_ok = (
        quote is not None
        and quote.get("status") == "LIVE"
        and source_quality == "CONVERGED"
        and isinstance(sources, int) and not isinstance(sources, bool) and sources >= 2
        and isinstance(spread_pct, (int, float)) and not isinstance(spread_pct, bool)
        and 0 <= spread_pct <= 0.5
    )
    if not quality_ok:
        return SignalResponse(
            symbol=payload.symbol.upper(),
            action="NO_TRADE",
            status="NO_SETUP",
            reason="Signal blocked: the live reference quote is unavailable or lacks verified multi-source consensus (at least two sources, spread no greater than 0.5%).",
            evaluated_at=datetime.now(timezone.utc),
            analysis={
                "market_data_quality": source_quality,
                "market_data_sources": sources,
                "market_data_spread_pct": spread_pct,
                "market_data_status": quote.get("status") if quote else "UNAVAILABLE",
                "signal_blocked_by_data_quality": True,
                "execution_enabled": False,
            },
        )
    result = evaluate(payload)
    result.analysis = {
        **result.analysis,
        "market_data_quality": source_quality,
        "market_data_sources": sources,
        "market_data_spread_pct": spread_pct,
        "market_data_status": quote.get("status"),
        "signal_blocked_by_data_quality": False,
        "execution_enabled": False,
    }
    return result


@app.post("/v1/research/data-quality")
def historical_data_quality(payload: CandleQualityRequest):
    return inspect_candle_series(payload.candles, payload.timeframe)


@app.post("/v1/backtest/ema-crossover")
def ema_crossover_backtest(payload: BacktestRequest):
    quality = inspect_candle_series(payload.candles, payload.timeframe)
    if quality["status"] != "CLEAN":
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Backtest blocked: historical candle series is not continuous and valid for the selected timeframe.",
                "data_quality": quality,
                "interpolation_applied": False,
            },
        )
    result = backtest(payload)
    result["data_quality"] = {
        "status": quality["status"],
        "timeframe": quality["timeframe"],
        "candle_count": quality["candle_count"],
        "gap_count": quality["gap_count"],
        "missing_intervals": quality["missing_intervals"],
        "interpolation_applied": False,
    }
    return result

@app.post("/v1/backtest/walk-forward")
def walk_forward_backtest(payload: WalkForwardRequest):
    quality = inspect_candle_series(payload.candles, payload.timeframe)
    if quality["status"] != "CLEAN":
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Walk-forward backtest blocked: historical candle series is not continuous and valid for the selected timeframe.",
                "data_quality": quality,
                "interpolation_applied": False,
            },
        )
    result = run_walk_forward_backtest(
        payload.candles,
        initial_train_size=payload.initial_train_size,
        test_size=payload.test_size,
        starting_capital=payload.starting_capital,
        fee_bps=payload.fee_bps,
        slippage_bps=payload.slippage_bps,
        spread_bps=payload.spread_bps,
    )
    result["data_quality"] = {
        "status": quality["status"],
        "timeframe": quality["timeframe"],
        "candle_count": quality["candle_count"],
        "gap_count": quality["gap_count"],
        "missing_intervals": quality["missing_intervals"],
        "interpolation_applied": False,
    }
    return result

