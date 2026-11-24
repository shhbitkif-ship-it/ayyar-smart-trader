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
