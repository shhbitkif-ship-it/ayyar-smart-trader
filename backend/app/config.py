"""Central runtime configuration. Secrets must never be committed to source control."""
import os

APP_NAME = "Ayyar Smart Trader"
DEFAULT_RISK_PER_TRADE = float(os.getenv("DEFAULT_RISK_PER_TRADE", "0.01"))
MAX_DAILY_LOSS = float(os.getenv("MAX_DAILY_LOSS", "0.03"))
MAX_DRAWDOWN = float(os.getenv("MAX_DRAWDOWN", "0.08"))
SIGNAL_MAX_AGE_SECONDS = int(os.getenv("SIGNAL_MAX_AGE_SECONDS", "90"))

if not 0 < DEFAULT_RISK_PER_TRADE <= 0.01:
    raise ValueError("DEFAULT_RISK_PER_TRADE must be > 0 and <= 0.01 (1%).")
if not 0 < MAX_DAILY_LOSS <= 0.10 or not 0 < MAX_DRAWDOWN <= 0.20:
    raise ValueError("Loss and drawdown limits are outside safe configured bounds.")
