# Scanner Weakness Audit (2026-05-23)

## P0 — Market flipping instability

`shared/copyTrader.ts:40-55` — `getLatencyMode` has zero hysteresis. A single median crossing the 8s threshold flips between 5m and 15m instantly. Since 5m and 15m markets have completely different condition IDs and traders, every flip discards all discovered candidates and starts over. Observed in live testing: the scanner constantly oscillates and can't settle on wallets.

**Fix**: Add hysteresis requiring N consecutive degraded samples before switching, OR just pin to 15m with a config flag (user's preference: track BTC 15m only).

## P0 — minLiveTradeUsdc is $5

`shared/copyTrader.ts:26` — `minLiveTradeUsdc: 5`. A $5 buy triggers a full signal. This is why low-volume wallets appeared — virtually anyone placing a single $5 bet generates a candidate.

**Fix**: Raise to at least 100.

## P1 — No volume floor in strict history filter

`shared/copyTrader.ts:57-58` — `passesStrictHistory` checks totalMarkets >= 20, totalPnl > 0, winRate >= 0.6, oneSidedRate >= 0.8. There is NO minimum volume check. A wallet with $1 trades across 20 markets passes if they're up $0.01.

**Fix**: Add `minTotalVolume` or `minAvgTradeSize` threshold.

## P1 — Leaderboard never wired into live scanner

Design doc specifies a "trusted lane" (weekly CRYPTO leaderboard + live market trades). `scripts/scanCandidates.ts` scans the leaderboard as a CLI tool, but the running `ScannerService` never calls `getLeaderboardTraders`. The live scanner only discovers wallets from current market trades — no persistent watchlist, no cross-reference with known performers.

**Fix**: Wire leaderboard fetch into ScannerService to seed a persistent wallet watchlist.

## P2 — Candidates vanish between scan cycles ✅ FIXED

`server/scannerService.ts:174-275` — `promoteCandidates` rebuilds the candidate list from scratch every scan. If a wallet is active in scan N but not N+1, it disappears instantly.

**Fix (ab00ab9)**: Candidates persist for 30s after last seen. Stale candidates show as `watch` recommendation. Merged with fresh candidates each scan.

## P2 — 15m lookback is shallow ✅ FIXED

`server/scannerService.ts:146` — When switching to 15m, `lookbackMarkets` is only 4 (vs 8 for 5m). Four 15m markets = 60 min of coverage but only 4 discrete events, limiting wallet discovery precisely when the system is already degraded.

**Fix (ab00ab9)**: Hardcoded `lookbackMarkets: 8` regardless of market type (120 min coverage for 15m).

## P3 — No remaining market time check ✅ FIXED

Scanner treats all active markets equally — a 15m market with 1 minute left is weighted the same as one with 14 minutes left. "Early entry" into a nearly-resolved market is meaningless.

**Fix (ab00ab9)**: Added `minMarketRemainingSeconds` (default 180 = 3 min) to config. Markets with less time remaining are skipped in signal evaluation.

## P3 — No leaderboard volume filter ✅ FIXED

`analyzeCandidate` stores `leaderboardVol` in the summary but never uses it for filtering. A wallet with $10 total volume on the leaderboard gets the same consideration as one with $10,000.

**Fix (ab00ab9)**: `buildHistorySummary` now passes real leaderboard vol/pnl/rank to `analyzeCandidate`. `scoreCandidate` factors `leaderboardVol` using log-scale scoring (weight 5/100). $10K vol = 0.8, $100K = 1.0.

## P3 — Duplicate utility code ✅ FIXED

`readJsonArray`, `getWinningOutcome`, `mapWithConcurrency` are copy-pasted across 5+ files (`scannerService.ts`, `candidateScanner.ts`, `polymarketClient.ts`, `scanCandidates.ts`, `findLiveBtc5Wallet.ts`).

**Fix (ab00ab9)**: Extracted into `shared/utils.ts`. All files now import from shared.
