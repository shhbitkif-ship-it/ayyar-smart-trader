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
