import pytest

from app.paper_accounts import (
    generate_account_credentials,
    hash_access_token,
    validate_account_settings,
)


def test_generated_account_credentials_are_unique_and_hash_only():
    account_a, token_a, hash_a = generate_account_credentials()
    account_b, token_b, hash_b = generate_account_credentials()
    assert len(account_a) == 32
    assert len(account_b) == 32
    assert account_a != account_b
    assert token_a != token_b
    assert len(token_a) >= 32
    assert hash_access_token(token_a) == hash_a
    assert token_a not in hash_a


@pytest.mark.parametrize("value", ["10000", True, None, float("inf"), float("nan"), 0, -1, 1_000_000_001])
def test_account_capital_rejects_invalid_values(value):
    with pytest.raises(ValueError):
        validate_account_settings({"starting_capital": value})


def test_account_settings_accept_only_supported_currencies():
    assert validate_account_settings({"starting_capital": 12500, "currency": "USD"}) == (12500.0, "USD")
    assert validate_account_settings({"starting_capital": 9000000, "currency": "IRT"}) == (9000000.0, "IRT")
    with pytest.raises(ValueError):
        validate_account_settings({"currency": "EUR"})


def test_account_settings_apply_safe_defaults():
    assert validate_account_settings({}) == (10000.0, "USD")


def test_access_token_hash_rejects_short_or_non_string_values():
    for value in ("short", "", None, 123):
        with pytest.raises(ValueError):
            hash_access_token(value)
