# Leaderboard Candidate Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI scanner that pulls the top 250 weekly CRYPTO leaderboard wallets and ranks BTC 5-minute copy-trade candidates.

**Architecture:** Keep scoring deterministic and testable in `shared/candidateScanner.ts`. Extend the existing Polymarket API client with leaderboard and event metadata methods. Add a `scripts/scanCandidates.ts` CLI that orchestrates API calls and writes Markdown/JSON reports for wallet-selection review.

**Tech Stack:** TypeScript, `tsx`, Vitest, Polymarket Data API, Polymarket Gamma API.

---

### Task 1: Candidate Scoring Core

**Files:**
- Create: `shared/candidateScanner.ts`
- Modify: `tests/polymarket.test.ts`

- [ ] Write failing tests for BTC 5-minute filtering, one-sided market scoring, early-entry scoring, PnL, and copyability score.
- [ ] Implement pure scoring helpers with no network dependencies.
- [ ] Run `npm test`.

### Task 2: Polymarket API Client Extensions

**Files:**
- Modify: `server/polymarketClient.ts`
- Modify: `shared/types.ts`

- [ ] Add typed leaderboard rows for `/v1/leaderboard`.
- [ ] Add typed Gamma event/market metadata for `/events?slug=...`.
- [ ] Add paginated activity fetching with `start`, `end`, `limit`, and `offset`.

### Task 3: CLI Report Script

**Files:**
- Create: `scripts/scanCandidates.ts`
- Modify: `package.json`

- [ ] Add `npm run scan:candidates`.
- [ ] Fetch top 250 weekly CRYPTO leaderboard wallets by PnL.
- [ ] Analyze each wallet's recent BTC 5-minute markets.
- [ ] Write Markdown and JSON reports under `reports/`.
- [ ] Print the top candidates and report paths.

### Task 4: Verification

**Files:**
- All touched files

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run the scanner with a small limit if network is available.
- [ ] Summarize output and any network/API limitations.
