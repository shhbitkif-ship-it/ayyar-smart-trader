import math
from pydantic import BaseModel, Field, model_validator
from .config import DEFAULT_RISK_PER_TRADE, MAX_DAILY_LOSS, MAX_DRAWDOWN

class PositionSizeRequest(BaseModel):
    equity: float = Field(gt=0, allow_inf_nan=False, description="Account equity in account currency")
    entry: float = Field(gt=0, allow_inf_nan=False)
    stop_loss: float = Field(gt=0, allow_inf_nan=False)
    contract_value_per_price_unit: float = Field(gt=0, allow_inf_nan=False, description="Verified broker contract value per 1.0 price move for one lot")
    risk_fraction: float = Field(default=DEFAULT_RISK_PER_TRADE, gt=0, le=0.01, allow_inf_nan=False)
    daily_loss_fraction: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    drawdown_fraction: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_stop(self):
        values=(self.equity,self.entry,self.stop_loss,self.contract_value_per_price_unit,self.risk_fraction,self.daily_loss_fraction,self.drawdown_fraction)
        if not all(math.isfinite(value) for value in values): raise ValueError("All risk inputs must be finite numbers")
        if self.entry == self.stop_loss: raise ValueError("entry and stop_loss must differ")
        return self


def calculate_position_size(req: PositionSizeRequest) -> dict:
    if req.daily_loss_fraction >= MAX_DAILY_LOSS:
        return {"allowed":False,"lots":0,"reason":"Daily loss limit reached; trading is blocked."}
    if req.drawdown_fraction >= MAX_DRAWDOWN:
        return {"allowed":False,"lots":0,"reason":"Maximum drawdown limit reached; trading is blocked."}
    risk_fraction=min(req.risk_fraction,DEFAULT_RISK_PER_TRADE,0.01)
    risk_amount=req.equity*risk_fraction
    stop_distance=abs(req.entry-req.stop_loss)
    loss_per_lot=stop_distance*req.contract_value_per_price_unit
    if loss_per_lot<=0: return {"allowed":False,"lots":0,"reason":"Invalid contract specification."}
    lots=risk_amount/loss_per_lot
    if not all(math.isfinite(value) and value > 0 for value in (risk_amount, stop_distance, loss_per_lot, lots)):
        return {"allowed":False,"lots":0,"reason":"Position size calculation exceeded safe numeric limits."}
    return {"allowed":True,"lots":lots,"risk_amount":risk_amount,"risk_fraction":risk_fraction,
            "stop_distance":stop_distance,"estimated_loss_at_stop":lots*loss_per_lot,
            "reason":"Sizing estimate only. Confirm tick value, lot step, margin, spread and broker rules before any order."}
