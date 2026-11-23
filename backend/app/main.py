from datetime import datetime,timezone
from fastapi import FastAPI
from .engine import evaluate
from .schemas import EvaluateRequest,SignalResponse
app=FastAPI(title="Ayyar Smart Trader API",version="0.2.0",description="Market-data safe scaffold; no fabricated prices or orders.")
@app.get("/health")
def health(): return {"status":"ok","service":"ayyar-smart-trader-api"}
@app.get("/v1/market/status")
def market_status(): return {"status":"UNAVAILABLE","reason":"No verified live market-data provider is configured.","as_of":datetime.now(timezone.utc)}
@app.post("/v1/signals/evaluate",response_model=SignalResponse)
def evaluate_signal(payload:EvaluateRequest): return evaluate(payload)
