from datetime import datetime
import math
from typing import Literal
from pydantic import BaseModel, Field, model_validator

class Candle(BaseModel):
    timestamp: datetime
    open: float = Field(gt=0, strict=True); high: float = Field(gt=0, strict=True); low: float = Field(gt=0, strict=True); close: float = Field(gt=0, strict=True)
    volume: float | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode="after")
    def validate_ohlc(self):
        for field in ("open", "high", "low", "close"):
            if not math.isfinite(getattr(self, field)):
                raise ValueError(f"{field} must be finite")
        if self.volume is not None and not math.isfinite(self.volume):
            raise ValueError("volume must be finite")
        if self.high < max(self.open,self.close,self.low):
            raise ValueError("high must be highest OHLC value")
        if self.low > min(self.open,self.close,self.high):
            raise ValueError("low must be lowest OHLC value")
        return self

class EvaluateRequest(BaseModel):
    symbol: str = Field(min_length=1,max_length=32)
    timeframe: Literal["1m","5m","15m","30m","1h","4h","1d"] = "1m"
    candles: list[Candle] = Field(min_length=1,max_length=5000)
    confirmation_candles: list[Candle] = Field(default_factory=list,max_length=5000)

class SignalResponse(BaseModel):
    symbol: str
    action: Literal["BUY","SELL","WAIT","NO_TRADE"]
    status: Literal["VALID","STALE","INSUFFICIENT_DATA","NO_SETUP"]
    reason: str
    evaluated_at: datetime
    entry: float | None = None; stop_loss: float | None = None; take_profit_1: float | None = None; risk_reward: float | None = None
    analysis: dict = Field(default_factory=dict)
