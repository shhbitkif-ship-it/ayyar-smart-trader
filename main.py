from datetime import datetime, timezone
from fastapi import FastAPI
from app.engine import evaluate
from app.schemas import EvaluateRequest, SignalResponse

app = FastAPI(title="Gold AI Trader API", version="0.1.0",
              description="Initial scaffold; live feeds are not connected.")

@app.get("/health")
def health():
    return {"status": "ok", "service": "gold-ai-trader-api"}

@app.get("/v1/market/status")
def market_status():
    return {"status": "UNAVAILABLE",
            "reason": "No licensed live market-data provider is configured.",
            "as_of": datetime.now(timezone.utc)}

@app.post("/v1/signals/evaluate", response_model=SignalResponse)
def evaluate_signal(payload: EvaluateRequest):
    return evaluate(payload)
