from datetime import datetime,timedelta,timezone
import pytest
import math
from pydantic import ValidationError
from app.engine import evaluate
from app.schemas import Candle,EvaluateRequest

def candles(n,step,start):
 return [Candle(timestamp=start+timedelta(minutes=step*i),open=2600+i*.1,high=2600+i*.1+.2,low=2600+i*.1-.2,close=2600+i*.1,volume=10) for i in range(n)]

def test_insufficient_data_is_no_trade():
 now=datetime.now(timezone.utc); req=EvaluateRequest(symbol="XAUUSD",candles=candles(20,1,now-timedelta(minutes=19)))
 out=evaluate(req,now); assert out.action=="NO_TRADE" and out.status=="INSUFFICIENT_DATA"

def test_missing_confirmation_is_no_trade():
 now=datetime.now(timezone.utc); req=EvaluateRequest(symbol="XAUUSD",candles=candles(220,1,now-timedelta(minutes=219)))
 out=evaluate(req,now); assert out.action=="NO_TRADE" and "confirmation" in out.reason.lower()

def test_stale_data_rejected():
 now=datetime.now(timezone.utc); req=EvaluateRequest(symbol="XAUUSD",candles=candles(220,1,now-timedelta(hours=6)))
 assert evaluate(req,now).status=="STALE"

def test_future_data_rejected():
 now=datetime.now(timezone.utc); req=EvaluateRequest(symbol="XAUUSD",candles=candles(220,1,now+timedelta(minutes=1)))
 assert evaluate(req,now).status=="STALE"


def test_analysis_includes_requested_indicators():
 now=datetime.now(timezone.utc)
 req=EvaluateRequest(symbol="XAUUSD",candles=candles(220,1,now-timedelta(minutes=219)))
 out=evaluate(req,now)
 assert out.action=="NO_TRADE"
 assert {"ema20","ema50","ema100","ema200","rsi14","macd","bollinger20","atr14","support_resistance","fibonacci"} <= set(out.analysis)


@pytest.mark.parametrize("field", ["open", "high", "low", "close", "volume"])
@pytest.mark.parametrize("bad_value", [float("nan"), float("inf"), float("-inf")])
def test_candle_rejects_non_finite_market_values(field, bad_value):
    values = dict(timestamp=datetime.now(timezone.utc), open=100, high=101, low=99, close=100, volume=10)
    values[field] = bad_value
    with pytest.raises(ValidationError):
        Candle(**values)


@pytest.mark.parametrize("field", ["open", "high", "low", "close", "volume"])
@pytest.mark.parametrize("bad_value", [True, False, "100"])
def test_candle_rejects_boolean_and_string_market_values(field, bad_value):
    values = dict(timestamp=datetime.now(timezone.utc), open=100, high=101, low=99, close=100, volume=10)
    values[field] = bad_value
    with pytest.raises(ValidationError):
        Candle(**values)


def test_duplicate_market_candle_timestamps_are_rejected():
    now = datetime.now(timezone.utc)
    data = candles(220, 1, now - timedelta(minutes=220))
    data[-1] = data[-2].model_copy()
    req = EvaluateRequest(symbol="XAUUSD", candles=data)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "duplicate" in result.reason.lower()


def test_naive_timestamp_in_any_market_candle_is_rejected():
    now = datetime.now(timezone.utc)
    data = candles(220, 1, now - timedelta(minutes=220))
    data[0] = data[0].model_copy(update={"timestamp": data[0].timestamp.replace(tzinfo=None)})
    req = EvaluateRequest(symbol="XAUUSD", candles=data)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "every market candle" in result.reason.lower()


def test_confirmation_candle_newer_than_market_data_is_rejected():
    now = datetime.now(timezone.utc)
    market = candles(220, 1, now - timedelta(minutes=221))
    confirmation = candles(60, 5, market[-1].timestamp - timedelta(minutes=296))
    confirmation[-1] = confirmation[-1].model_copy(update={"timestamp": market[-1].timestamp + timedelta(minutes=1)})
    req = EvaluateRequest(symbol="XAUUSD", candles=market, confirmation_candles=confirmation)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "confirmation data is stale" in result.reason.lower()


def test_duplicate_confirmation_timestamps_are_rejected():
    now = datetime.now(timezone.utc)
    market = candles(220, 1, now - timedelta(minutes=220))
    confirmation = candles(60, 1, now - timedelta(minutes=60))
    confirmation[-1] = confirmation[-2].model_copy()
    req = EvaluateRequest(symbol="XAUUSD", candles=market, confirmation_candles=confirmation)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "duplicate confirmation" in result.reason.lower()


@pytest.mark.parametrize("timeframe,step", [("1m", 5), ("5m", 20), ("15m", 60), ("30m", 120), ("1h", 240)])
def test_large_intraday_history_gap_is_no_trade(timeframe, step):
    now = datetime.now(timezone.utc)
    data = candles(220, 1, now - timedelta(minutes=220))
    # Introduce a gap well beyond the permitted interval in the middle.
    for index in range(110, len(data)):
        data[index] = data[index].model_copy(update={"timestamp": data[index].timestamp + timedelta(minutes=step)})
    req = EvaluateRequest(symbol="XAUUSD", timeframe=timeframe, candles=data)
    result = evaluate(req, now + timedelta(minutes=step))
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "gap" in result.reason.lower()


def test_daily_history_allows_weekend_gap():
    now = datetime.now(timezone.utc)
    data = candles(220, 1440, now - timedelta(days=222))
    data[150:] = [c.model_copy(update={"timestamp": c.timestamp + timedelta(days=2)}) for c in data[150:]]
    req = EvaluateRequest(symbol="XAUUSD", timeframe="1d", candles=data)
    result = evaluate(req, now)
    assert result.status != "STALE" or "gap" not in result.reason.lower()


def test_out_of_order_market_candles_are_rejected_without_sorting():
    now = datetime.now(timezone.utc)
    data = candles(220, 1, now - timedelta(minutes=220))
    data[100], data[101] = data[101], data[100]
    req = EvaluateRequest(symbol="XAUUSD", candles=data)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "out of order" in result.reason.lower()




def test_confirmation_candles_are_not_silently_sorted():
    now = datetime.now(timezone.utc)
    market = candles(220, 1, now - timedelta(minutes=220))
    confirmation = candles(60, 1, now - timedelta(minutes=60))
    confirmation[20], confirmation[21] = confirmation[21], confirmation[20]
    req = EvaluateRequest(symbol="XAUUSD", candles=market, confirmation_candles=confirmation)
    result = evaluate(req, now)
    assert result.action == "NO_TRADE"
    assert result.status == "STALE"
    assert "out of order" in result.reason.lower()


def test_market_regime_classifier_detects_bullish_bearish_and_sideways():
    from app.engine import _classify_market_regime
    closes = [100 + i * 0.2 for i in range(220)]
    bullish = _classify_market_regime(
        [110+i*.1 for i in range(6)], [109+i*.08 for i in range(6)],
        [108+i*.06 for i in range(6)], [107+i*.04 for i in range(6)],
        closes, [60]*6, [0.5]*6)
    assert bullish["trend"] == "BULLISH"
    assert bullish["signal_quality"] == "GOOD"

    bearish = _classify_market_regime(
        [110-i*.1 for i in range(6)], [111-i*.08 for i in range(6)],
        [112-i*.06 for i in range(6)], [113-i*.04 for i in range(6)],
        closes, [40]*6, [0.5]*6)
    assert bearish["trend"] == "BEARISH"

    sideways = _classify_market_regime(
        [100]*6, [100]*6, [100]*6, [100]*6,
        [100]*220, [50]*6, [0.5]*6)
    assert sideways["trend"] == "SIDEWAYS"
    assert sideways["signal_quality"] == "WEAK"


def test_narrow_ema_separation_does_not_masquerade_as_directional_trend():
    from app.engine import _classify_market_regime
    result = _classify_market_regime(
        [100.04, 100.036, 100.032, 100.028, 100.024, 100.02],
        [100.020, 100.019, 100.018, 100.017, 100.016, 100.015],
        [100.014, 100.013, 100.012, 100.011, 100.0105, 100.010],
        [100.005] * 6,
        [100.0] * 220, [45] * 6, [0.5] * 6,
    )
    assert result["trend"] == "SIDEWAYS"
    assert result["signal_quality"] == "WEAK"


def test_market_regime_flags_extreme_volatility_as_weak():
    from app.engine import _classify_market_regime
    result = _classify_market_regime(
        [110+i*.1 for i in range(6)], [109+i*.08 for i in range(6)],
        [108+i*.06 for i in range(6)], [107+i*.04 for i in range(6)],
        [100+i*.2 for i in range(220)], [60]*6, [3.0]*6)
    assert result["signal_quality"] == "WEAK"
    assert result["volatility_pct"] > 2.0


def test_engine_exposes_market_regime_analysis():
    now = datetime.now(timezone.utc)
    req = EvaluateRequest(symbol="XAUUSD", candles=candles(220, 1, now-timedelta(minutes=219)))
    result = evaluate(req, now)
    assert result.analysis["trend"] in {"BULLISH", "BEARISH", "SIDEWAYS", "UNKNOWN"}
    assert result.analysis["signal_quality"] in {"GOOD", "WEAK", "INSUFFICIENT"}


@pytest.mark.parametrize(
    "name,e20,e50,e100,e200,atr_value,expected_trend,expected_volatility,expected_quality",
    [
        ("bullish", [110+i*.1 for i in range(6)], [109+i*.08 for i in range(6)],
         [108+i*.06 for i in range(6)], [107+i*.04 for i in range(6)],
         0.5, "BULLISH", "NORMAL", "GOOD"),
        ("bearish", [90-i*.1 for i in range(6)], [91-i*.08 for i in range(6)],
         [92-i*.06 for i in range(6)], [93-i*.04 for i in range(6)],
         0.5, "BEARISH", "NORMAL", "GOOD"),
        ("sideways", [100]*6, [100]*6, [100]*6, [100]*6,
         0.5, "SIDEWAYS", "NORMAL", "WEAK"),
        ("high_volatility", [110+i*.1 for i in range(6)], [109+i*.08 for i in range(6)],
         [108+i*.06 for i in range(6)], [107+i*.04 for i in range(6)],
         3.0, "BULLISH", "HIGH", "WEAK"),
    ],
)
def test_engine_classifies_four_market_conditions(
    name, e20, e50, e100, e200, atr_value,
    expected_trend, expected_volatility, expected_quality,
):
    from app.engine import _classify_market_regime
    result = _classify_market_regime(
        e20, e50, e100, e200,
        [100+i*.2 for i in range(220)],
        [60]*6,
        [atr_value]*6,
    )
    assert result["trend"] == expected_trend, name
    assert result["volatility_regime"] == expected_volatility, name
    assert result["signal_quality"] == expected_quality, name


def test_engine_marks_low_volatility_as_weak_and_explicit():
    from app.engine import _classify_market_regime
    result = _classify_market_regime(
        [110+i*.1 for i in range(6)], [109+i*.08 for i in range(6)],
        [108+i*.06 for i in range(6)], [107+i*.04 for i in range(6)],
        [100+i*.2 for i in range(220)], [60]*6, [0.01]*6,
    )
    assert result["volatility_regime"] == "LOW"
    assert result["signal_quality"] == "WEAK"


def test_engine_analysis_exposes_volatility_regime():
    now = datetime.now(timezone.utc)
    req = EvaluateRequest(
        symbol="XAUUSD",
        candles=candles(220, 1, now-timedelta(minutes=219)),
    )
    result = evaluate(req, now)
    assert result.analysis["volatility_regime"] in {"LOW", "NORMAL", "HIGH", "UNKNOWN"}


def test_market_regime_classifier_accepts_scalar_atr_from_indicator():
    from app.engine import _classify_market_regime
    result = _classify_market_regime(
        [110+i*.1 for i in range(6)], [109+i*.08 for i in range(6)],
        [108+i*.06 for i in range(6)], [107+i*.04 for i in range(6)],
        [100+i*.2 for i in range(220)], [60]*6, 0.5,
    )
    assert result["volatility_regime"] == "NORMAL"
    assert result["signal_quality"] == "GOOD"


def test_market_regime_classifier_marks_missing_atr_as_unknown():
    from app.engine import _classify_market_regime
    result = _classify_market_regime(
        [110+i*.1 for i in range(6)], [109+i*.08 for i in range(6)],
        [108+i*.06 for i in range(6)], [107+i*.04 for i in range(6)],
        [100+i*.2 for i in range(220)], [60]*6, None,
    )
    assert result["trend"] == "UNKNOWN"
    assert result["volatility_regime"] == "UNKNOWN"
    assert result["signal_quality"] == "INSUFFICIENT"


def _regime_scenario_candles(kind, count, start, step_minutes=1):
    result = []
    previous = 2600.0
    for index in range(count):
        if kind == "BULLISH":
            close = 2600 + index * 0.08 + 0.7 * math.sin(index * 0.45)
        elif kind == "BEARISH":
            close = 2600 - index * 0.08 + 0.7 * math.sin(index * 0.45)
        elif kind == "SIDEWAYS":
            close = 2600 + 1.2 * math.sin(index * 0.4)
        else:  # directional trend with deliberately extreme intrabar ranges
            close = 2600 + index * 0.08 + 0.7 * math.sin(index * 0.45)
        wick = 35.0 if kind == "HIGH_VOLATILITY" else 0.3
        open_price = previous
        high = max(open_price, close) + wick
        low = min(open_price, close) - wick
        result.append(Candle(
            timestamp=start + timedelta(minutes=step_minutes * index),
            open=open_price, high=high, low=low, close=close, volume=100,
        ))
        previous = close
    return result


@pytest.mark.parametrize(
    "scenario,expected_trend,expected_volatility",
    [
        ("BULLISH", "BULLISH", "NORMAL"),
        ("BEARISH", "BEARISH", "NORMAL"),
        ("SIDEWAYS", "SIDEWAYS", "NORMAL"),
        ("HIGH_VOLATILITY", "BULLISH", "HIGH"),
    ],
)
def test_full_engine_scenario_diagnostics_are_safe_and_directional(
    scenario, expected_trend, expected_volatility,
):
    now = datetime.now(timezone.utc)
    market = _regime_scenario_candles(
        scenario, 220, now - timedelta(minutes=220),
    )
    confirmation_kind = "BEARISH" if scenario == "BEARISH" else "BULLISH"
    confirmation = _regime_scenario_candles(
        confirmation_kind, 60, now - timedelta(minutes=297), 5,
    )
    # Keep the final higher-timeframe candle older than the evaluated market candle.
    confirmation[-1] = confirmation[-1].model_copy(
        update={"timestamp": market[-1].timestamp - timedelta(seconds=30)}
    )
    request = EvaluateRequest(
        symbol="XAUUSD", timeframe="1m",
        candles=market, confirmation_candles=confirmation,
    )
    result = evaluate(request, now)

    assert result.status != "STALE"
    assert result.analysis["trend"] == expected_trend
    assert result.analysis["volatility_regime"] == expected_volatility
    assert result.analysis["setup_direction"] in {"LONG", "SHORT", "NONE"}
    assert result.analysis["setup_detected"] is (
        result.analysis["setup_direction"] in {"LONG", "SHORT"}
    )
    # This engine is deliberately advisory: it must never emit an executable order.
    assert result.action in {"WAIT", "NO_TRADE"}
    assert result.action not in {"BUY", "SELL"}
    if result.analysis["setup_detected"]:
        assert result.action == "WAIT"
        assert result.status == "VALID"
    else:
        assert result.status == "NO_SETUP"


def test_engine_reports_setup_none_for_missing_higher_timeframe_confirmation():
    now = datetime.now(timezone.utc)
    request = EvaluateRequest(
        symbol="XAUUSD",
        candles=_regime_scenario_candles(
            "BULLISH", 220, now - timedelta(minutes=220),
        ),
    )
    result = evaluate(request, now)
    assert result.action == "NO_TRADE"
    assert result.analysis["setup_direction"] == "NONE"
    assert result.analysis["setup_detected"] is False


def test_signal_fingerprint_is_stable_for_repeated_evaluation():
    now = datetime.now(timezone.utc)
    market = _regime_scenario_candles("BULLISH", 220, now - timedelta(minutes=220))
    confirmation = _regime_scenario_candles("BULLISH", 60, now - timedelta(minutes=297), 5)
    confirmation[-1] = confirmation[-1].model_copy(
        update={"timestamp": market[-1].timestamp - timedelta(seconds=30)}
    )
    request = EvaluateRequest(
        symbol="XAUUSD", timeframe="1m",
        candles=market, confirmation_candles=confirmation,
    )
    first = evaluate(request, now)
    second = evaluate(request, now)
    assert first.analysis["signal_key"] == second.analysis["signal_key"]
    assert first.analysis["signal_key"] is None or len(first.analysis["signal_key"]) == 64



def test_signal_fingerprint_changes_when_confirmation_bar_changes():
    now = datetime.now(timezone.utc)
    market = _regime_scenario_candles("BULLISH", 220, now - timedelta(minutes=220))
    confirmation = _regime_scenario_candles("BULLISH", 60, now - timedelta(minutes=297), 5)
    confirmation[-1] = confirmation[-1].model_copy(
        update={"timestamp": market[-1].timestamp - timedelta(seconds=30)}
    )
    first_request = EvaluateRequest(
        symbol="XAUUSD", timeframe="1m",
        candles=market, confirmation_candles=confirmation,
    )
    updated_confirmation = list(confirmation)
    updated_confirmation[-1] = updated_confirmation[-1].model_copy(
        update={"timestamp": market[-1].timestamp - timedelta(minutes=1)}
    )
    second_request = EvaluateRequest(
        symbol="XAUUSD", timeframe="1m",
        candles=market, confirmation_candles=updated_confirmation,
    )
    first = evaluate(first_request, now)
    second = evaluate(second_request, now)
    assert first.analysis["setup_detected"] is True
    assert second.analysis["setup_detected"] is True
    assert first.analysis["signal_key"] != second.analysis["signal_key"]


def test_signal_fingerprint_changes_when_candle_values_are_corrected():
    now = datetime.now(timezone.utc)
    market = _regime_scenario_candles("BULLISH", 220, now - timedelta(minutes=220))
    confirmation = _regime_scenario_candles("BULLISH", 60, now - timedelta(minutes=297), 5)
    confirmation[-1] = confirmation[-1].model_copy(
        update={"timestamp": market[-1].timestamp - timedelta(seconds=30)}
    )
    first_request = EvaluateRequest(
        symbol="XAUUSD", timeframe="1m",
        candles=market, confirmation_candles=confirmation,
    )
    corrected_confirmation = list(confirmation)
    last = corrected_confirmation[-1]
    corrected_confirmation[-1] = last.model_copy(
        update={"close": last.close + 0.01, "high": last.high + 0.01}
    )
    second_request = EvaluateRequest(
        symbol="XAUUSD", timeframe="1m",
        candles=market, confirmation_candles=corrected_confirmation,
    )
    first = evaluate(first_request, now)
    second = evaluate(second_request, now)
    assert first.analysis["setup_detected"] is True
    assert second.analysis["setup_detected"] is True
    assert first.analysis["signal_key"] != second.analysis["signal_key"]

def test_no_setup_has_no_signal_fingerprint():
    now = datetime.now(timezone.utc)
    request = EvaluateRequest(
        symbol="XAUUSD",
        candles=_regime_scenario_candles("SIDEWAYS", 220, now - timedelta(minutes=220)),
    )
    result = evaluate(request, now)
    assert result.analysis["setup_direction"] == "NONE"
    assert result.analysis["signal_key"] is None
