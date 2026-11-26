from fastapi import FastAPI, HTTPException
from .engine import evaluate
from .schemas import EvaluateRequest, SignalResponse
from .market_data import market_snapshot
from .config import DEFAULT_RISK_PER_TRADE, MAX_DAILY_LOSS, MAX_DRAWDOWN
from .risk import PositionSizeRequest, calculate_position_size, TradePlanRequest, validate_trade_plan
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


@app.post("/v1/signals/evaluate", response_model=SignalResponse)
def evaluate_signal(payload: EvaluateRequest):
    return evaluate(payload)


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

