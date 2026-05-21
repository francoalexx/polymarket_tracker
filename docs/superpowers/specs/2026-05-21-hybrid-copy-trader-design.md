# Hybrid Copy-Trader GUI Design

## Purpose

Build a local GUI program that continuously finds high-quality Polymarket crypto copy-trade candidates, tracks their live wallet activity, and prepares manually confirmed entry and exit orders. V1 runs only while the local app/server is open.

This is a planning spec, not a commitment to automated trading. All V1 order submission requires explicit manual confirmation in the GUI.

## Current Context

The repo already contains:

- A React/Vite GUI with an Express server and server-sent event wallet stream.
- `server/streamSession.ts`, which polls wallet activity every 1 second and positions every 3 seconds.
- `shared/candidateScanner.ts`, which scores historical BTC 5-minute wallets.
- `scripts/scanCandidates.ts`, which scans weekly CRYPTO leaderboard wallets and writes reports.
- `scripts/findLiveBtc5Wallet.ts`, which already discovers recent live BTC 5-minute wallets from market trades.

The current tracker shows trades roughly 20 seconds after placement in some cases. Because the app already polls activity every 1 second, the likely bottleneck is public Polymarket feed freshness rather than local polling frequency. V1 must measure latency continuously and adapt market selection instead of assuming BTC 5-minute signals are always actionable.

## Product Shape

The program has three core loops:

1. Discover live wallets in current/recent BTC short-term markets.
2. Promote only wallets that pass strict historical quality filters.
3. Prepare entry or exit trade tickets for manual confirmation.

The GUI becomes a combined scanner, wallet tracker, and trade-ticket workspace.

Primary GUI areas:

- Candidate Feed: ranked live candidates with source, market type, score, and latency status.
- Signal Detail: explanation of why a wallet passed or failed filters.
- Wallet Tracker: existing positions and trade tape, linked to selected candidates.
- Trade Tickets: pending entry and exit tickets requiring manual confirmation.
- Execution Log: submitted order responses, errors, partial fills, and rejected tickets.

## Discovery Sources

V1 uses a hybrid discovery model:

- Trusted lane: weekly CRYPTO leaderboard wallets.
- Live lane: wallets that appear in current/recent BTC 5-minute or 15-minute market trades.

The trusted lane provides known performers. The live lane catches emerging wallets that may not already be on the leaderboard. Both lanes feed the same scoring and promotion pipeline.

## Market Selection

BTC 5-minute markets are primary.

BTC 15-minute markets become primary when measured signal latency is too high for BTC 5-minute copy trading.

Rules:

- If median recent detection latency is less than or equal to 8 seconds, promote BTC 5-minute candidates first.
- If median recent detection latency is above 8 seconds, mark BTC 5-minute as `latency-degraded` and promote BTC 15-minute candidates first.
- Late BTC 5-minute signals may still appear as watch-only signals.
- Exit signals should still surface even during degraded latency, because they may help risk management.

## Promotion Criteria

A wallet becomes a copy-trade candidate only when it has both:

- A live qualifying signal.
- Strict historical quality.

Live signal requirements:

- BTC 5-minute market when latency is acceptable, otherwise BTC 15-minute.
- One-sided current-market behavior.
- Early entry into the market.
- Active recently, with last detected trade within the configured 10 to 20 minute window.
- Candidate trade size above a configured minimum.
- Entry price below a configured maximum unless manually overridden.
- Detection arrived early enough for the market duration.

Historical quality requirements:

- At least 20 prior BTC 5-minute or 15-minute markets.
- Positive historical PnL.
- Win rate at least 60%.
- One-sided rate at least 80%.

Additional filters:

- Minimum live trade size to suppress dust/noise.
- Maximum candidate entry price to avoid chasing expensive entries.
- No late-entry entry tickets, even for historically strong wallets.
- Repeat-wallet cooldown per wallet/market to avoid duplicate ticket spam.

## Candidate Explanation

Every promoted candidate must include enough context to audit the recommendation:

- Wallet and display name when available.
- Discovery source: leaderboard, live market, or both.
- Market type: BTC 5-minute or BTC 15-minute.
- Candidate side: Up or Down.
- First entry seconds after market start.
- Last detected trade age.
- Current-market one-sided status.
- Historical market count.
- Historical win rate.
- Historical PnL and ROI.
- Historical one-sided rate.
- Estimated detection latency.
- Recommendation: watch, prepare entry, prepare exit, or latency degraded.

## Trade Tickets

V1 prepares both entry and exit tickets.

Entry tickets:

- Default spend is 10 USDC.
- Use a GTD limit order.
- Price up to 5 cents worse than the candidate's observed trade price.
- Round price to market tick size.
- Require manual confirmation before submission.

Exit tickets:

- Trigger from candidate SELL behavior.
- Sell only the matching shares the local account currently holds.
- Cap size at available local token balance.
- Use a GTD limit order with 5 cents of price protection in the sell direction.
- Require manual confirmation before submission.

Every ticket shows:

- Wallet and market.
- Entry or exit.
- Outcome side.
- Candidate observed price.
- Proposed limit price.
- Proposed amount or shares.
- Expiration.
- Reason for creation.
- Confirm and cancel actions.

## Trading Integration

Use a hybrid bridge for V1:

- Keep the TypeScript/Node app as the main server and GUI.
- Copy relevant Python trading code from `https://github.com/francoalexx/polymarket-babygain` into this repo.
- Adapt that code into a single-ticket execution script.
- Wrap it behind a TypeScript `TradingProvider` interface.

The TypeScript interface keeps scanner and GUI code independent from the Python implementation. A native TypeScript CLOB implementation can replace the Python bridge later without changing candidate detection or UI flows.

The copied Python pieces should include:

- `.env` loading conventions.
- Private key, API credential, signature type, and funder address handling.
- GTD order expiration logic.
- Order placement through `py-clob-client-v2`.
- Existing helpful auth mismatch errors for proxy/deposit wallet flows.

Secrets remain server-side. The browser never receives private keys, API secrets, passphrases, or signing material.

Relevant Polymarket docs:

- WebSocket overview and authenticated user channel: `https://docs.polymarket.com/market-data/websocket/overview`
- User channel credential safety: `https://docs.polymarket.com/market-data/websocket/user-channel`
- CLOB order creation: `https://docs.polymarket.com/developers/CLOB/orders/create-order`
- Order lifecycle: `https://docs.polymarket.com/concepts/order-lifecycle`

## Latency Measurement

For each detected trade, record:

- Trade timestamp from Polymarket.
- App receive timestamp.
- Estimated latency in seconds.
- Source endpoint or feed.
- Market duration.
- Whether the signal was still actionable when received.

The scanner should compare practical latency between:

- Market trades endpoint, such as `/trades?market=...`.
- User activity endpoint, such as `/activity?user=...`.

If market trades are consistently fresher, live discovery should depend on market trades while the wallet tracker continues using activity and positions for display.

## Server/API Design

The Express server owns all long-running services:

- Scanner service lifecycle.
- Candidate state.
- Latency state.
- Ticket queue.
- Trading bridge calls.
- Execution log.

Likely server endpoints/events:

- `GET /api/scanner/stream`: SSE feed for candidate, latency, ticket, and execution updates.
- `GET /api/candidates`: latest candidate snapshot.
- `GET /api/candidates/:wallet`: signal detail snapshot.
- `POST /api/tickets/:id/confirm`: submit a prepared ticket.
- `POST /api/tickets/:id/cancel`: dismiss a prepared ticket.
- `GET /api/trading/status`: dry-run/live readiness and credential validation without exposing secrets.

The exact endpoint shape can change during implementation if tests or local patterns suggest a cleaner split.

## Error Handling

Scanner errors:

- Surface API errors in a scanner status panel.
- Continue scanning other lanes when one lane fails.
- Mark stale data clearly.

Trading errors:

- Never retry order submission silently.
- Show rejected orders in the execution log.
- Preserve the ticket and response for audit.
- Validate dry-run/live mode before allowing confirmation.
- Show credential readiness without exposing credential values.

Latency degradation:

- Clearly label BTC 5-minute candidates as degraded.
- Prefer BTC 15-minute candidates until latency recovers.
- Do not prepare late BTC 5-minute entry tickets.

## Non-Goals For V1

- Fully automatic order submission without confirmation.
- Persistent background service when the app is closed.
- Daily risk cap.
- Native TypeScript trading client rewrite.
- Non-BTC crypto markets.
- Automated position sizing beyond the 10 USDC default entry amount.

## Verification Plan

Unit tests:

- BTC 5-minute and 15-minute market classification.
- Early-entry detection.
- One-sided live market grouping.
- Strict historical promotion thresholds.
- Minimum live trade size filter.
- Maximum entry price filter.
- Repeat-wallet cooldown.
- Entry ticket price math with 5-cent slippage and tick rounding.
- Exit ticket size capped by available shares.

Integration tests:

- Scanner service emits candidates and latency states from mocked Polymarket clients.
- Trading provider dry-run accepts a ticket payload and returns a structured response.
- Confirm endpoint calls trading provider only after explicit confirmation.

Manual/live diagnostics:

- Run a small diagnostic comparing `/trades?market=...` and `/activity?user=...` freshness.
- Verify the GUI downgrades BTC 5-minute when latency exceeds 8 seconds.
- Verify dry-run ticket creation for one entry and one exit path before enabling live mode.

## Open Implementation Notes

- The prior Python trading project uses Python and `py-clob-client-v2`; this repo currently uses Node/TypeScript. V1 should copy only execution-related Python code and keep all strategy/scanner logic in TypeScript.
- The Polymarket authenticated user WebSocket is useful for this user's own submitted order lifecycle, not for detecting another wallet's public trades. Public candidate discovery should be measured against available market/user public feeds.
- Polymarket order minimums and tick sizes must be validated against live market metadata before submission.
