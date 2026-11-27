import pytest
from pydantic import ValidationError
from app.risk import PositionSizeRequest, calculate_position_size

def test_risk_above_one_percent_is_rejected():
    with pytest.raises(ValidationError):
        PositionSizeRequest(equity=10000,entry=2500,stop_loss=2490,contract_value_per_price_unit=1,risk_fraction=0.02)

def test_daily_loss_blocks_new_trade():
    req=PositionSizeRequest(equity=10000,entry=2500,stop_loss=2490,contract_value_per_price_unit=1,daily_loss_fraction=0.03)
    assert calculate_position_size(req)["allowed"] is False

def test_drawdown_blocks_new_trade():
    req=PositionSizeRequest(equity=10000,entry=2500,stop_loss=2490,contract_value_per_price_unit=1,drawdown_fraction=0.08)
    assert calculate_position_size(req)["allowed"] is False

def test_equal_entry_stop_is_rejected():
    with pytest.raises(ValidationError):
        PositionSizeRequest(equity=10000,entry=2500,stop_loss=2500,contract_value_per_price_unit=1)


@pytest.mark.parametrize("field,value", [
    ("equity", float("inf")),
    ("entry", float("nan")),
    ("stop_loss", float("inf")),
    ("contract_value_per_price_unit", float("inf")),
    ("risk_fraction", float("nan")),
    ("daily_loss_fraction", float("inf")),
    ("drawdown_fraction", float("nan")),
])
def test_position_sizing_rejects_non_finite_inputs(field, value):
    values=dict(equity=10000,entry=2500,stop_loss=2490,contract_value_per_price_unit=1)
    values[field]=value
    with pytest.raises(ValidationError):
        PositionSizeRequest(**values)


def test_position_sizing_fails_closed_on_numeric_overflow():
    req=PositionSizeRequest(equity=1e308,entry=1e308,stop_loss=1,contract_value_per_price_unit=1e308)
    result=calculate_position_size(req)
    assert result["allowed"] is False
    assert result["lots"] == 0


@pytest.mark.parametrize(
    "side,entry,stop,target,expected_ratio",
    [
        ("LONG", 100, 95, 110, 2.0),
        ("SHORT", 100, 105, 90, 2.0),
    ],
)
def test_trade_plan_accepts_correct_direction_and_reports_reward_risk(
    side, entry, stop, target, expected_ratio,
):
    from app.risk import TradePlanRequest, validate_trade_plan
    result = validate_trade_plan(TradePlanRequest(
        side=side, entry=entry, stop_loss=stop, take_profit=target,
    ))
    assert result["valid"] is True
    assert result["risk_reward"] == expected_ratio
    assert result["execution_enabled"] is False


@pytest.mark.parametrize(
    "side,entry,stop,target",
    [
        ("LONG", 100, 105, 110),
        ("LONG", 100, 95, 90),
        ("SHORT", 100, 95, 90),
        ("SHORT", 100, 105, 110),
    ],
)
def test_trade_plan_rejects_stop_or_target_on_wrong_side(side, entry, stop, target):
    from app.risk import TradePlanRequest
    with pytest.raises(ValidationError):
        TradePlanRequest(side=side, entry=entry, stop_loss=stop, take_profit=target)


def test_trade_plan_rejects_reward_risk_below_minimum():
    from app.risk import TradePlanRequest, validate_trade_plan
    result = validate_trade_plan(TradePlanRequest(
        side="LONG", entry=100, stop_loss=95, take_profit=106,
        minimum_risk_reward=1.5,
    ))
    assert result["valid"] is False
    assert result["risk_reward"] == 1.2
    assert result["execution_enabled"] is False


def test_trade_plan_rejects_non_finite_and_invalid_thresholds():
    from app.risk import TradePlanRequest
    with pytest.raises(ValidationError):
        TradePlanRequest(side="LONG", entry=float("inf"), stop_loss=95, take_profit=110)
    with pytest.raises(ValidationError):
        TradePlanRequest(side="LONG", entry=100, stop_loss=95, take_profit=110, minimum_risk_reward=0)


@pytest.mark.parametrize(
    "side,expected_stop,expected_target",
    [
        ("LONG", 97.0, 106.0),
        ("SHORT", 103.0, 94.0),
    ],
)
def test_atr_plan_builds_directional_levels_without_enabling_execution(
    side, expected_stop, expected_target,
):
    from app.risk import AtrTradePlanRequest, build_atr_trade_plan
    result = build_atr_trade_plan(AtrTradePlanRequest(
        side=side, entry=100, atr_value=2,
        stop_atr_multiple=1.5, reward_risk=2,
    ))
    assert result["valid"] is True
    assert result["stop_loss"] == expected_stop
    assert result["take_profit"] == expected_target
    assert result["risk_reward"] == 2
    assert result["execution_enabled"] is False


def test_atr_plan_rejects_prices_below_zero_after_level_calculation():
    from app.risk import AtrTradePlanRequest, build_atr_trade_plan
    result = build_atr_trade_plan(AtrTradePlanRequest(
        side="LONG", entry=1, atr_value=2,
    ))
    assert result["valid"] is False
    assert result["execution_enabled"] is False


def test_atr_plan_rejects_non_finite_or_extreme_inputs():
    from app.risk import AtrTradePlanRequest, build_atr_trade_plan
    with pytest.raises(ValidationError):
        AtrTradePlanRequest(side="LONG", entry=100, atr_value=float("inf"))
    req = AtrTradePlanRequest(
        side="LONG", entry=1e308, atr_value=1e308,
        stop_atr_multiple=5, reward_risk=5,
    )
    result = build_atr_trade_plan(req)
    assert result["valid"] is False
    assert result["execution_enabled"] is False


@pytest.mark.parametrize(
    "entry,atr_value",
    [
        (1e-9, 1e-10),  # rounded stop would become zero
        (100, 1e-10),   # rounded levels would collapse onto entry
    ],
)
def test_atr_plan_rejects_levels_that_become_invalid_after_rounding(entry, atr_value):
    from app.risk import AtrTradePlanRequest, build_atr_trade_plan
    result = build_atr_trade_plan(AtrTradePlanRequest(
        side="LONG", entry=entry, atr_value=atr_value,
    ))
    assert result["valid"] is False
    assert result["execution_enabled"] is False
