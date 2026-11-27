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


def _daily_candles(count=80):
    from datetime import datetime, timedelta, timezone
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    candles = []
    for i in range(count):
        price = 3000 + (i if i < count // 2 else count - i)
        candles.append({
            "timestamp": (start + timedelta(days=i)).isoformat(),
            "open": price, "high": price + 2, "low": price - 2,
            "close": price, "volume": 100,
        })
    return candles


def test_backtest_endpoint_accepts_clean_timeframe_and_returns_quality():
    response = client.post("/v1/backtest/ema-crossover", json={"candles": _daily_candles(80), "timeframe": "1d"})
    assert response.status_code == 200
    body = response.json()
    assert body["strategy"] == "EMA20/EMA50 long-only crossover"
    assert body["cost_model"]["fee_bps_per_side"] == 10.0
    assert body["cost_model"]["slippage_bps_per_side"] == 5.0
    assert body["data_quality"]["status"] == "CLEAN"
    assert body["data_quality"]["timeframe"] == "1d"
    assert body["data_quality"]["interpolation_applied"] is False
    assert "max_drawdown_pct" in body


def test_backtest_endpoint_rejects_too_few_candles():
    response = client.post("/v1/backtest/ema-crossover", json={"candles": []})
    assert response.status_code == 422


def test_historical_data_quality_endpoint_reports_gaps_without_interpolation():
    from datetime import datetime, timedelta, timezone
    start = datetime(2026, 11, 2, tzinfo=timezone.utc)
    candles = []
    for minutes in (0, 15, 45, 60):
        candles.append({
            "timestamp": (start + timedelta(minutes=minutes)).isoformat(),
            "open": 3000, "high": 3002, "low": 2998, "close": 3001,
        })
    response = client.post("/v1/research/data-quality", json={"timeframe": "15m", "candles": candles})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "GAPPED"
    assert body["missing_intervals"] == 1
    assert body["interpolation_applied"] is False


def test_backtest_endpoint_blocks_gapped_candles_without_interpolation():
    from datetime import datetime, timedelta, timezone
    start = datetime(2026, 11, 2, tzinfo=timezone.utc)
    candles = []
    for minutes in range(0, 15 * 80, 15):
        if minutes == 15 * 35:
            continue
        price = 3000 + (minutes // 15) % 10
        candles.append({
            "timestamp": (start + timedelta(minutes=minutes)).isoformat(),
            "open": price, "high": price + 2, "low": price - 2, "close": price,
        })
    response = client.post("/v1/backtest/ema-crossover", json={"candles": candles, "timeframe": "15m"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "not continuous" in detail["message"]
    assert detail["data_quality"]["status"] == "GAPPED"
    assert detail["data_quality"]["missing_intervals"] == 1
    assert detail["interpolation_applied"] is False


def test_backtest_endpoint_accepts_and_reports_full_spread():
    response = client.post("/v1/backtest/ema-crossover", json={
        "candles": _daily_candles(80), "timeframe": "1d", "spread_bps": 18,
    })
    assert response.status_code == 200
    assert response.json()["cost_model"]["spread_bps_full"] == 18
    assert response.json()["cost_model"]["spread_bps_per_side"] == 9


def _signal_request(symbol="XAUUSD"):
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    candles = []
    for index in range(220):
        price = 3000 + index * 0.1
        candles.append({
            "timestamp": (now - timedelta(minutes=220-index)).isoformat(),
            "open": price, "high": price + 1, "low": price - 1,
            "close": price, "volume": 10,
        })
    return {"symbol": symbol, "timeframe": "1m", "candles": candles}


def test_signal_endpoint_blocks_unavailable_or_single_source_market_data(monkeypatch):
    async def snapshot():
        return {
            "status": "PARTIAL",
            "quotes": [{
                "symbol": "XAUUSD", "status": "LIVE", "price": 3000,
                "meta": {"source_quality": "SINGLE_SOURCE", "sources": 1, "spread_pct": None},
            }],
        }

    monkeypatch.setattr("app.main.market_snapshot", snapshot)
    response = client.post("/v1/signals/evaluate", json=_signal_request())
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "NO_TRADE"
    assert body["status"] == "NO_SETUP"
    assert body["analysis"]["signal_blocked_by_data_quality"] is True
    assert body["analysis"]["market_data_quality"] == "SINGLE_SOURCE"


def test_signal_endpoint_requires_server_verified_multi_source_consensus(monkeypatch):
    async def snapshot():
        return {
            "status": "LIVE",
            "quotes": [{
                "symbol": "XAUUSD", "status": "LIVE", "price": 3000,
                "meta": {"source_quality": "CONVERGED", "sources": 3, "spread_pct": 0.3},
            }],
        }

    called = {"value": False}
    def fake_evaluate(payload):
        called["value"] = True
        from app.schemas import SignalResponse
        from datetime import datetime, timezone
        return SignalResponse(
            symbol=payload.symbol, action="NO_TRADE", status="NO_SETUP",
            reason="Test evaluator", evaluated_at=datetime.now(timezone.utc), analysis={},
        )

    monkeypatch.setattr("app.main.market_snapshot", snapshot)
    monkeypatch.setattr("app.main.evaluate", fake_evaluate)
    response = client.post("/v1/signals/evaluate", json=_signal_request())
    assert response.status_code == 200
    assert called["value"] is True
    body = response.json()
    assert body["analysis"]["market_data_quality"] == "CONVERGED"
    assert body["analysis"]["market_data_sources"] == 3
    assert body["analysis"]["signal_blocked_by_data_quality"] is False


def test_signal_endpoint_blocks_unknown_instrument_reference(monkeypatch):
    async def snapshot():
        return {"status": "LIVE", "quotes": []}

    monkeypatch.setattr("app.main.market_snapshot", snapshot)
    response = client.post("/v1/signals/evaluate", json=_signal_request("UNKNOWN"))
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "NO_TRADE"
    assert body["analysis"]["signal_blocked_by_data_quality"] is True
