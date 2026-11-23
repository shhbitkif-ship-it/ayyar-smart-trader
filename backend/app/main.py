from datetime import datetime, timezone
from fastapi import FastAPI
from .engine import evaluate
from .schemas import EvaluateRequest, SignalResponse
from .market_data import market_snapshot
from .config import DEFAULT_RISK_PER_TRADE, MAX_DAILY_LOSS, MAX_DRAWDOWN

app = FastAPI(title="Ayyar Smart Trader API", version="0.3.0",
              description="Iran and global gold market data with stale-data protection and conservative signal evaluation.")

@app.get("/health")
def health():
    return {"status": "ok", "service": "ayyar-smart-trader-api", "version": "0.3.0"}

@app.get("/v1/market/status")
def market_status():
    snapshot = market_snapshot()
    return {"status": snapshot["status"], "as_of": snapshot["as_of"],
            "live_quotes": sum(1 for q in snapshot["quotes"] if q["status"] == "LIVE"),
            "total_quotes": len(snapshot["quotes"])}

@app.get("/v1/market/quotes")
def market_quotes():
    return market_snapshot()

@app.get("/v1/risk/policy")
def risk_policy():
    return {"default_risk_per_trade": DEFAULT_RISK_PER_TRADE,
            "max_daily_loss": MAX_DAILY_LOSS, "max_drawdown": MAX_DRAWDOWN,
            "execution_enabled": False,
            "note": "Risk limits are policy defaults; broker-specific sizing and execution remain disabled until instrument specifications are verified."}

@app.post("/v1/signals/evaluate", response_model=SignalResponse)
def evaluate_signal(payload: EvaluateRequest):
    return evaluate(payload)
