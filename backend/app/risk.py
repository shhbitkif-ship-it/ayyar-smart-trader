import math
from typing import Literal
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


class TradePlanRequest(BaseModel):
    side: Literal["LONG", "SHORT"]
    entry: float = Field(gt=0, allow_inf_nan=False)
    stop_loss: float = Field(gt=0, allow_inf_nan=False)
    take_profit: float = Field(gt=0, allow_inf_nan=False)
    minimum_risk_reward: float = Field(default=1.5, gt=0, le=10, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_trade_geometry(self):
        values = (self.entry, self.stop_loss, self.take_profit, self.minimum_risk_reward)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Trade plan values must be finite.")
        if self.side == "LONG":
            if not self.stop_loss < self.entry < self.take_profit:
                raise ValueError("LONG plan requires stop_loss < entry < take_profit.")
        elif not self.take_profit < self.entry < self.stop_loss:
            raise ValueError("SHORT plan requires take_profit < entry < stop_loss.")
        return self


def validate_trade_plan(req: TradePlanRequest) -> dict:
    """Validate directional stop/target geometry and minimum reward-to-risk."""
    risk_distance = abs(req.entry - req.stop_loss)
    reward_distance = abs(req.take_profit - req.entry)
    if risk_distance <= 0 or not math.isfinite(risk_distance + reward_distance):
        return {"valid": False, "reason": "Trade distances are invalid or exceed safe numeric limits."}
    ratio = reward_distance / risk_distance
    if not math.isfinite(ratio):
        return {"valid": False, "reason": "Risk/reward calculation exceeded safe numeric limits."}
    valid = ratio >= req.minimum_risk_reward
    return {
        "valid": valid,
        "side": req.side,
        "risk_distance": round(risk_distance, 8),
        "reward_distance": round(reward_distance, 8),
        "risk_reward": round(ratio, 4),
        "minimum_risk_reward": req.minimum_risk_reward,
        "reason": (
            "Trade plan meets the minimum risk/reward requirement."
            if valid else
            "Trade plan rejected: reward is below the configured minimum relative to risk."
        ),
        "execution_enabled": False,
    }


class AtrTradePlanRequest(BaseModel):
    side: Literal["LONG", "SHORT"]
    entry: float = Field(gt=0, allow_inf_nan=False)
    atr_value: float = Field(gt=0, allow_inf_nan=False)
    stop_atr_multiple: float = Field(default=1.5, gt=0, le=5, allow_inf_nan=False)
    reward_risk: float = Field(default=2.0, ge=1.5, le=5, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_finite_plan(self):
        if not all(math.isfinite(v) for v in (
            self.entry, self.atr_value, self.stop_atr_multiple, self.reward_risk
        )):
            raise ValueError("ATR trade plan inputs must be finite.")
        return self


def build_atr_trade_plan(req: AtrTradePlanRequest) -> dict:
    """Build indicative ATR-based levels; never authorizes execution."""
    stop_distance = req.atr_value * req.stop_atr_multiple
    reward_distance = stop_distance * req.reward_risk
    if not all(math.isfinite(v) and v > 0 for v in (stop_distance, reward_distance)):
        return {"valid": False, "execution_enabled": False,
                "reason": "ATR level calculation exceeded safe numeric limits."}
    if req.side == "LONG":
        stop_loss = req.entry - stop_distance
        take_profit = req.entry + reward_distance
    else:
        stop_loss = req.entry + stop_distance
        take_profit = req.entry - reward_distance
    if stop_loss <= 0 or take_profit <= 0 or not all(
        math.isfinite(v) for v in (stop_loss, take_profit)
    ):
        return {"valid": False, "execution_enabled": False,
                "reason": "Calculated price levels are not valid positive prices."}

    # Validate the levels after display rounding as well: tiny ATR values can
    # otherwise round a stop/target to zero or collapse it onto the entry.
    rounded_stop = round(stop_loss, 8)
    rounded_target = round(take_profit, 8)
    if req.side == "LONG":
        geometry_valid = 0 < rounded_stop < req.entry < rounded_target
    else:
        geometry_valid = 0 < rounded_target < req.entry < rounded_stop
    if not geometry_valid:
        return {
            "valid": False,
            "execution_enabled": False,
            "reason": "Rounded ATR levels collapse or violate the required trade geometry.",
        }

    actual_risk = abs(req.entry - rounded_stop)
    actual_reward = abs(rounded_target - req.entry)
    actual_reward_risk = actual_reward / actual_risk
    if not math.isfinite(actual_reward_risk) or actual_reward_risk < req.reward_risk:
        return {
            "valid": False,
            "execution_enabled": False,
            "reason": "Rounded ATR levels do not preserve the requested minimum reward/risk.",
        }

    return {
        "valid": True,
        "side": req.side,
        "entry": req.entry,
        "stop_loss": rounded_stop,
        "take_profit": rounded_target,
        "atr_value": req.atr_value,
        "stop_distance": round(actual_risk, 8),
        "reward_distance": round(actual_reward, 8),
        "risk_reward": round(actual_reward_risk, 4),
        "basis": "Indicative ATR multiple; broker tick size, spread, liquidity and structure are not applied.",
        "execution_enabled": False,
    }
