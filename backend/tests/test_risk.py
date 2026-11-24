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
