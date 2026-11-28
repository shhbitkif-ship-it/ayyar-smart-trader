# Broker and live market-data integration

## Decision

Broker-originated market data is a valid next step, but it must be integrated as **read-only data first**. A broker quote is not automatically a tick feed, an executable price, or an independent confirmation of global XAU/USD.

Keep live order placement disabled. Never scrape an authenticated account, store a brokerage password, bypass a CAPTCHA, or infer a quote timestamp from the time our Worker fetched it.

## Candidate sources

| Source | Market coverage | Access model | What is verified | Intended role |
|---|---|---|---|---|
| HedgeTech Core / HedgeTech Python SDK | Iran Mercantile Exchange (IME) futures, options and deposit certificates; TSE/IFB shares, funds and related instruments | Authenticated account; REST snapshots and WebSocket streams | The published SDK documents live snapshots and WebSocket streams through `core.hedgetech.ir`. It requires a HedgeTech account. | Preferred candidate for authorized live Iranian exchange data, subject to confirming the exact gold instrument, permissions, latency and redistribution rights. |
| Mofid Bourse View (EasyTrader ecosystem) | Tehran exchange stocks and ETFs, including gold ETFs where listed | Unofficial public JSON endpoints used by Mofid's website; no documented public API | A third-party read-only integration reports 30–60 second polling/cache, unaudited/delayed data, and 1-minute-to-weekly history. The broker does not document this as a public API. | Optional secondary snapshot for the exact ETF symbol (for example, عیار), not a tick feed and not a proxy for spot XAU/USD. |
| Agah public market views | Iranian listed shares and funds | Unofficial public website JSON; no documented public API | A third-party read-only integration reports polled snapshots and non-guaranteed freshness. | Possible second Iranian-market comparison source after a live smoke test. |
| StreamData | Iranian gold/FX, Tehran market, global FX/metals and other markets | API token; REST and WebSocket | The service advertises streaming and REST data, with stated limits of 60 REST requests/minute and 5 WebSocket connections. Current price, licensing and latency were not independently confirmed. | Candidate for broad Iranian + global feeds after written pricing, latency and data-use terms are confirmed. |
| Existing XAUS + BIQUOTE | Global XAU/USD spot/candles | Public read-only feeds | Current code validates freshness, completed bars, OHLC integrity, gaps and cross-provider consensus. | Remains the current global XAU/USD path; do not replace its validation gates. |

## Instrument separation

- **XAU/USD spot** is a global OTC/CFD reference quote, normally in USD per troy ounce.
- **عیار (Ayar)** is a listed Iranian gold ETF unit traded on the Iranian commodity exchange. Its price includes ETF-specific supply/demand, premium/discount to NAV, local trading hours and market microstructure.
- **18k gram, mesghal, coin and USD/IRT** are separate Iranian price series with their own units, sources and update schedules.

Never compare or merge these as if they were the same instrument. A live Ayar quote can support a separate Ayar instrument view and later a dedicated Ayar strategy; it cannot confirm an XAU/USD candle.

## Acceptance gates for a broker adapter

A provider must pass all of these before its data can be labelled LIVE or used by a signal:

1. **Instrument identity:** exact exchange symbol/ISIN and asset type are resolved from the provider, not guessed or hard-coded from a third-party page.
2. **Source timestamp:** use the provider's actual exchange/trade timestamp. Fetch time is metadata only and cannot make an old quote fresh.
3. **Freshness:** set an instrument-specific maximum age. For a broker snapshot cached/polled every 30–60 seconds, expose that cadence honestly; do not market it as tick-by-tick.
4. **Market state:** detect trading session, halt, auction, closed market and stale last-trade time. A previous session's close is not a live quote.
5. **Price integrity:** positive finite values, expected unit/currency, valid bid/ask ordering, and no impossible jumps without a flagged market event.
6. **Candles:** only completed bars; validate monotonic aligned timestamps, OHLC bounds, duplicates and gaps. Do not synthesize missing bars.
7. **Independent consensus:** compare only equivalent instruments and matching intervals. Ayar ETF data must not be cross-validated against XAU/USD spot as though they were identical.
8. **Operational limits:** bounded timeouts, low request rate, caching within provider terms, explicit attribution, and clear handling of HTTP 401/403/429/5xx.
9. **Permissions:** confirm the provider permits the intended personal/app display and any redistribution. Unofficial website endpoints may change or be restricted without notice.
10. **Fail closed:** if any required field is absent or stale, return UNAVAILABLE/STALE and block dependent signals.

## Implementation sequence

1. Confirm whether HedgeTech has enabled a read-only Data Engine account for the user and whether it exposes the exact gold ETF/futures/certificate instruments needed. Use only Data Engine permissions; do not enable EMS order execution.
2. Run a time-bounded live diagnostic from the deployed backend: provider timestamp, local receive time, latency, quote age, reconnects, missing messages, symbol identity and market state. Do not log credentials or JWTs.
3. In parallel, validate whether Mofid's public Ayar snapshot is accessible from the Cloudflare Worker and record its real last-trade timestamp. Treat it as an experimental secondary snapshot only.
4. Add the provider behind a feature flag and a dedicated instrument endpoint. Do not alter the existing XAU/USD consensus or permit an Iranian ETF quote to satisfy it.
5. Keep the source in shadow mode until at least several full trading sessions have been observed and the timestamp/freshness/error-rate checks pass. Only then consider it for a separate paper strategy.

## Current status

No broker feed is currently approved for live signals. HedgeTech's documented stream capability is the strongest official candidate, but account entitlement and exact instrument coverage still need confirmation. Mofid/Agah public views are useful research leads, not guaranteed real-time APIs. StreamData requires token/pricing/terms confirmation. Until a provider passes the acceptance gates, the existing engine must continue to return `NO_TRADE` whenever its current source-consensus checks fail.
