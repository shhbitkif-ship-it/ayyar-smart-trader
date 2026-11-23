# Ayyar Smart Trader — Product Specification

This document consolidates the owner's master requirements. The product is intended to become a real Android application backed by a secure API, not a static mockup.

## 1. Markets and instruments
- Global: XAU/USD spot, gold futures where a licensed/reliable feed is available, US Dollar Index (DXY), and relevant FX benchmarks.
- Iran: 18K and 24K gram gold, mesghal / melted gold, Emami and Bahar Azadi coins (full, half, quarter and gram where supported), USD free-market rate, and relevant local premiums/bubbles.
- Every quote must carry its source, unit, timestamp, freshness status and provider metadata. Never silently mix toman/rial or spot/derived market values.

## 2. Data-source requirements
- Use documented providers and server-side API credentials; never place API keys in the Android binary or public repository.
- Primary Iran adapter: Talasanj API (gram18, gram24, mazaneh, coin_full, coin_half, coin_quarter, usd, ounce).
- Global precious-metal adapter: Metals.Dev spot gold endpoint; Talasanj ounce is a labelled fallback.
- Add secondary providers only after endpoint terms, units, timestamps, refresh cadence and reliability are verified. Provider disagreement must be surfaced, not averaged blindly.
- Enforce stale-data checks and explicit UNAVAILABLE state. No fallback may disguise old data as live.
- Historical OHLC/tick data is required for intraday indicators, backtests and model training. Snapshot-only feeds are not sufficient.

## 3. Technical analysis
- Indicators: RSI, MACD, EMA 20/50/100/200, Bollinger Bands, ATR, Fibonacci retracements, support/resistance, VWAP and volume-derived measures when valid volume exists.
- Price action and market structure: liquidity sweeps, break of structure (BOS), change of character (CHoCH), supply/demand zones, and candle patterns.
- Timeframes: 1m, 5m, 15m, 30m, 1h, 4h and daily, with multi-timeframe confirmation.
- Do not infer volume, order flow or futures basis from price-only data. Mark unavailable inputs clearly.

## 4. Fundamental context
- Track scheduled and released CPI, PCE, Federal Reserve rate decisions/statements, central-bank activity, major geopolitical events and relevant macro releases.
- Store event time in UTC and display local time; distinguish forecast, previous and actual values and cite the source.
- Fundamental/news context must not be represented as a real-time signal until a licensed, timestamped source and event calendar are connected.

## 5. Signals and trade plans
- Allowed states: BUY, SELL, WAIT and NO_TRADE.
- A complete validated signal should contain entry zone, stop loss, TP1/TP2/TP3, risk/reward, confidence/strength, reasons, timeframe alignment, source timestamps, creation time and expiry/invalidation conditions.
- If any critical input is stale, incomplete, contradictory or unverified, return NO_TRADE with a reason.
- The current engine is deliberately conservative: trend alignment may produce WAIT only. Executable BUY/SELL levels remain disabled until spread, tick size, contract size, lot step, liquidity and market-specific execution rules are verified.

## 6. Risk management
- Default risk per trade must never exceed 1% of account equity.
- Enforce daily loss and maximum drawdown locks; the current policy defaults are 3% daily loss and 8% maximum drawdown and must remain configurable.
- Position sizing must use verified contract value and stop distance; do not guess contract specifications.
- Real broker execution is out of scope until the owner explicitly enables it after testing. Current execution is disabled.

## 7. Backtesting and machine learning
- Build reproducible backtesting with realistic spread, commission, slippage, contract specifications, session boundaries and out-of-sample validation.
- Record win rate, expectancy, profit factor, max drawdown, Sharpe/Sortino where appropriate, sample size and confidence intervals.
- ML is a later research layer only: no fabricated accuracy, no training on future data, no leakage, walk-forward validation and a baseline strategy comparison are mandatory before any model can influence live signals.

## 8. Android and Telegram
- Android UI: Persian-first, readable dashboard, black/gold visual system, global and Iran market panels, source/time/freshness labels, chart/indicator views, signal details, risk controls, history and performance reporting.
- Auto-refresh must respect provider rate limits and show loading/error/stale states.
- Telegram bot remains available with /gold, /iran and /market commands, using the same backend quote service.
- Notifications should be configurable and must not claim a signal exists when the engine returns NO_TRADE.

## 9. Quality, security and delivery
- Automated Python tests and Android builds on GitHub Actions; test failure means no APK release.
- Keep credentials in Render environment variables or equivalent secret storage. Never commit bot tokens, provider keys or signing keys.
- Release delivery target: installable Android APK plus complete source. Debug artifacts are for testing only; a signed release requires a securely stored signing key.
- Keep an audit trail for quotes, signal decisions, strategy version, risk checks and provider outages.

## 10. Current implementation checkpoint
- Implemented: FastAPI scaffold, Talasanj and Metals.Dev adapters, stale quote status, Android quote dashboard, Telegram shared quote client, EMA/RSI/MACD/Bollinger/ATR/VWAP/support-resistance/Fibonacci calculations, multi-timeframe confirmation gate, risk policy and position-size calculator.
- Not yet implemented/verified: Render deployment, live provider credentials, historical intraday OHLC ingestion, DXY/futures feed, macro/news calendar, full signal plans and expiry/history, backtest engine, validated ML, signed release APK.
- The build pipeline must pass before an APK is called installable. No successful build is claimed in this checkpoint.
