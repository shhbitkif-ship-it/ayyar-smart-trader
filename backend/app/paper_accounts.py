"""Pure validation helpers for the persistent paper-account API."""
import hashlib
import math
import secrets

SUPPORTED_CURRENCIES = {"USD", "IRT"}
MAX_STARTING_CAPITAL = 1_000_000_000.0


def generate_account_credentials():
    account_id = secrets.token_hex(16)
    access_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(access_token.encode("utf-8")).hexdigest()
    return account_id, access_token, token_hash


def hash_access_token(token):
    if not isinstance(token, str) or len(token) < 32 or len(token) > 256:
        raise ValueError("A valid bearer access token is required")
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def validate_account_settings(payload):
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object")
    capital = payload.get("starting_capital", 10000)
    currency = payload.get("currency", "USD")
    if isinstance(capital, bool) or not isinstance(capital, (int, float)):
        raise ValueError("starting_capital must be a JSON number")
    if not math.isfinite(capital) or capital <= 0 or capital > MAX_STARTING_CAPITAL:
        raise ValueError("starting_capital is outside the supported range")
    if currency not in SUPPORTED_CURRENCIES:
        raise ValueError("currency must be USD or IRT")
    return float(capital), currency
