from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health_endpoint():
    response=client.get("/health")
    assert response.status_code==200
    assert response.json()["status"]=="ok"

def test_quotes_without_provider_keys_never_fabricate_prices(monkeypatch):
    monkeypatch.delenv("TALASANJ_KEY",raising=False)
    monkeypatch.delenv("METALS_DEV_KEY",raising=False)
    response=client.get("/v1/market/quotes")
    assert response.status_code==200
    assert response.json()["status"]=="UNAVAILABLE"
    assert all(q["price"] is None for q in response.json()["quotes"])

def test_risk_policy_defaults_are_conservative():
    response=client.get("/v1/risk/policy")
    assert response.status_code==200
    assert response.json()["default_risk_per_trade"]<=0.01
    assert response.json()["execution_enabled"] is False
