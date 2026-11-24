from fastapi.testclient import TestClient
from app.main import app
import app.market_data as market_data

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_quotes_provider_failure_never_fabricates_prices(monkeypatch):
    async def provider_unavailable():
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(market_data, "_fetch_provider_json", provider_unavailable)
    monkeypatch.setattr(market_data, "_cache", None)
    monkeypatch.setattr(market_data, "_cache_at", 0.0)

    response = client.get("/v1/market/quotes")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "UNAVAILABLE"
    assert all(quote["price"] is None for quote in body["quotes"])


def test_risk_policy_defaults_are_conservative():
    response = client.get("/v1/risk/policy")
    assert response.status_code == 200
    assert response.json()["default_risk_per_trade"] <= 0.01
    assert response.json()["execution_enabled"] is False



def test_backtest_endpoint_accepts_ohlc_and_returns_research_metrics():
    from datetime import datetime, timedelta, timezone

    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    candles = []
    for i in range(60):
        price = 3000 + i
        candles.append({
            "timestamp": (start + timedelta(days=i)).isoformat(),
            "open": price,
            "high": price + 2,
            "low": price - 2,
            "close": price,
            "volume": 100,
        })
    response = client.post("/v1/backtest/ema-crossover", json={"candles": candles})
    assert response.status_code == 200
    body = response.json()
    assert body["strategy"] == "EMA20/EMA50 long-only crossover"
    assert body["cost_model"]["fee_bps_per_side"] == 10.0
    assert body["cost_model"]["slippage_bps_per_side"] == 5.0
    assert "max_drawdown_pct" in body
    assert body["warning"].startswith("Research only")


def test_backtest_endpoint_rejects_too_few_candles():
    response = client.post("/v1/backtest/ema-crossover", json={"candles": []})
    assert response.status_code == 422
