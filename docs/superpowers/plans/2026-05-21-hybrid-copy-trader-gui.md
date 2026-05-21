# Hybrid Copy-Trader GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local scanner + tracker + manually confirmed copy-trade ticket GUI for strict BTC 5-minute and 15-minute Polymarket copy-trade candidates.

**Architecture:** Keep strategy, filtering, latency, and ticket math in deterministic TypeScript modules under `shared/`. Run a server-owned scanner service from Express, stream scanner state to React over SSE, and submit confirmed tickets through a narrow TypeScript `TradingProvider` that calls copied Python execution code from `polymarket-babygain`.

**Tech Stack:** TypeScript, React, Vite, Express, SSE, Vitest, Python, `py-clob-client-v2`, Polymarket Data API, Polymarket Gamma API, Polymarket CLOB.

---

## File Structure

Create these files:

- `shared/copyTrader.ts`: Pure market classification, live-wallet summarization, strict promotion filters, latency-state helpers, cooldown helpers, and entry/exit ticket construction.
- `server/scannerService.ts`: Long-running scanner service with injected `PolymarketClient`, in-memory scanner state, polling timers, candidate promotion, ticket creation, and subscriber notification.
- `server/tradingProvider.ts`: TypeScript interface plus Python bridge implementation for dry-run/live ticket submission.
- `server/scannerRoutes.ts`: Express route registration for scanner SSE, candidate snapshots, ticket confirm/cancel, and trading status.
- `trading/bridge/execute_ticket.py`: Single-ticket Python command that reads JSON from stdin and returns JSON to stdout.
- `trading/bridge/babygain_bridge/__init__.py`: Python package marker.
- `trading/bridge/babygain_bridge/config.py`: Copied/adapted `.env` and credential config from `polymarket-babygain`.
- `trading/bridge/babygain_bridge/trader.py`: Copied/adapted GTD order execution from `polymarket-babygain`.
- `trading/requirements.txt`: Python dependency list for the bridge.
- `scripts/diagnoseLatency.ts`: Live-data diagnostic comparing market trades with wallet activity freshness.
- `src/scannerApi.ts`: Client-side SSE and REST helpers.

Modify these files:

- `shared/types.ts`: Add scanner, candidate, latency, ticket, execution, and short-term market metadata types.
- `shared/candidateScanner.ts`: Generalize BTC 5-minute filtering to BTC 5-minute and BTC 15-minute history scoring.
- `shared/polymarket.ts`: Reuse or delegate short-term market predicates to `shared/copyTrader.ts`.
- `server/polymarketClient.ts`: Add live market/trade metadata methods and typed Data/Gamma API helpers.
- `server/index.ts`: Instantiate the scanner service and register scanner routes.
- `src/main.tsx`: Add scanner feed, signal detail, ticket queue, execution log, and link candidate selection to the existing wallet tracker.
- `src/styles.css`: Add responsive styles for the scanner workspace.
- `tests/polymarket.test.ts`: Add pure scanner, ticket, and latency tests.
- `package.json`: Add `scan:latency` script.
- `.gitignore`: Add `.env`, `.venv/`, and `trading/.venv/`.

---

### Task 1: Shared Scanner Types And Pure Copy-Trading Logic

**Files:**
- Create: `shared/copyTrader.ts`
- Modify: `shared/types.ts`
- Modify: `shared/candidateScanner.ts`
- Modify: `shared/polymarket.ts`
- Modify: `tests/polymarket.test.ts`

- [ ] **Step 1: Write failing tests for BTC 5m/15m classification, latency mode, strict promotion, cooldown, and ticket math**

Add these imports to the existing import section at the top of `tests/polymarket.test.ts`:

```ts
import {
  buildEntryTicket,
  buildExitTicket,
  getLatencyMode,
  isBtcShortTermTrade,
  shouldSuppressRepeatSignal,
  summarizeLiveWallet,
  passesStrictHistory
} from "../shared/copyTrader";
import type { CandidateSummary } from "../shared/candidateScanner";
import type { CopyTraderConfig, MarketMetadata, SignalCooldownKey } from "../shared/types";
```

Append this test block to `tests/polymarket.test.ts` before helper functions:

```ts
describe("hybrid copy trader pure logic", () => {
  const config: CopyTraderConfig = {
    primaryMarketType: "5m",
    fallbackMarketType: "15m",
    latencyThresholdSeconds: 8,
    activeWithinSeconds: 20 * 60,
    earlyEntrySeconds: 90,
    minLiveTradeUsdc: 5,
    maxEntryPrice: 0.85,
    repeatCooldownSeconds: 240,
    defaultEntrySpendUsdc: 10,
    maxSlippageCents: 5
  };

  it("classifies BTC 5m and BTC 15m trades without matching ETH", () => {
    expect(isBtcShortTermTrade(trade({ slug: "btc-updown-5m-1778315400" }), "5m")).toBe(true);
    expect(isBtcShortTermTrade(trade({ slug: "btc-updown-15m-1778315400" }), "15m")).toBe(true);
    expect(isBtcShortTermTrade(trade({ slug: "btc-updown-15m-1778315400" }), "5m")).toBe(false);
    expect(isBtcShortTermTrade(trade({ slug: "eth-updown-5m-1778315400", title: "Ethereum Up or Down" }), "5m")).toBe(false);
  });

  it("marks BTC 5m as degraded when median latency exceeds threshold", () => {
    expect(getLatencyMode([{ latencySeconds: 3 }, { latencySeconds: 5 }, { latencySeconds: 7 }], config)).toEqual({
      activeMarketType: "5m",
      isDegraded: false,
      medianLatencySeconds: 5
    });
    expect(getLatencyMode([{ latencySeconds: 9 }, { latencySeconds: 11 }, { latencySeconds: 20 }], config)).toEqual({
      activeMarketType: "15m",
      isDegraded: true,
      medianLatencySeconds: 11
    });
  });

  it("summarizes an early one-sided live wallet and rejects dust or late entries", () => {
    const market: MarketMetadata = {
      conditionId: "0xlive",
      slug: "btc-updown-5m-1000",
      title: "Bitcoin Up or Down",
      marketType: "5m",
      startTimestamp: 1000,
      endTimestamp: 1300,
      outcomes: [
        { name: "Up", tokenId: "up-token", price: 0.54 },
        { name: "Down", tokenId: "down-token", price: 0.46 }
      ],
      minTickSize: 0.01,
      negRisk: false
    };

    const signal = summarizeLiveWallet(
      "0xlivewallet00000000000000000000000000000000",
      [
        trade({
          proxyWallet: "0xlivewallet00000000000000000000000000000000",
          conditionId: "0xlive",
          slug: market.slug,
          timestamp: 1020,
          side: "BUY",
          outcome: "Up",
          asset: "up-token",
          size: 30,
          usdcSize: 16.2,
          price: 0.54
        })
      ],
      market,
      1040,
      config
    );

    expect(signal?.recommendation).toBe("prepare_entry");
    expect(signal?.firstEntrySeconds).toBe(20);
    expect(signal?.isOneSided).toBe(true);

    expect(
      summarizeLiveWallet(
        "0xdustwallet000000000000000000000000000000000",
        [trade({ conditionId: "0xlive", slug: market.slug, timestamp: 1020, usdcSize: 1, price: 0.54 })],
        market,
        1040,
        config
      )
    ).toBeUndefined();

    expect(
      summarizeLiveWallet(
        "0xlatewallet000000000000000000000000000000000",
        [trade({ conditionId: "0xlive", slug: market.slug, timestamp: 1210, usdcSize: 20, price: 0.54 })],
        market,
        1220,
        config
      )?.recommendation
    ).toBe("watch");
  });

  it("applies strict historical promotion thresholds", () => {
    const summary = candidateSummary({ totalMarkets: 20, totalPnl: 100, winRate: 0.6, oneSidedRate: 0.8 });
    expect(passesStrictHistory(summary)).toBe(true);
    expect(passesStrictHistory(candidateSummary({ totalMarkets: 19, totalPnl: 100, winRate: 0.6, oneSidedRate: 0.8 }))).toBe(false);
    expect(passesStrictHistory(candidateSummary({ totalMarkets: 20, totalPnl: -1, winRate: 0.9, oneSidedRate: 0.9 }))).toBe(false);
    expect(passesStrictHistory(candidateSummary({ totalMarkets: 20, totalPnl: 100, winRate: 0.59, oneSidedRate: 0.9 }))).toBe(false);
    expect(passesStrictHistory(candidateSummary({ totalMarkets: 20, totalPnl: 100, winRate: 0.9, oneSidedRate: 0.79 }))).toBe(false);
  });

  it("suppresses repeat signals inside the cooldown window", () => {
    const key: SignalCooldownKey = { wallet: "0xabc", conditionId: "0xmarket", kind: "entry" };
    const seen = new Map<string, number>();
    expect(shouldSuppressRepeatSignal(key, seen, 1000, config)).toBe(false);
    expect(shouldSuppressRepeatSignal(key, seen, 1100, config)).toBe(true);
    expect(shouldSuppressRepeatSignal(key, seen, 1300, config)).toBe(false);
  });

  it("builds entry and exit tickets with slippage, tick rounding, and balance caps", () => {
    const market: MarketMetadata = {
      conditionId: "0xticket",
      slug: "btc-updown-5m-2000",
      title: "Bitcoin Up or Down",
      marketType: "5m",
      startTimestamp: 2000,
      endTimestamp: 2300,
      outcomes: [{ name: "Up", tokenId: "up-token", price: 0.54 }],
      minTickSize: 0.01,
      negRisk: false
    };

    const entry = buildEntryTicket({
      wallet: "0xcandidate",
      market,
      outcome: "Up",
      asset: "up-token",
      observedPrice: 0.54,
      candidateTradeId: "trade-1",
      now: 2010,
      config
    });

    expect(entry.kind).toBe("entry");
    expect(entry.spendUsdc).toBe(10);
    expect(entry.limitPrice).toBe(0.59);
    expect(entry.size).toBeCloseTo(16.9491, 4);

    const exit = buildExitTicket({
      wallet: "0xcandidate",
      market,
      outcome: "Up",
      asset: "up-token",
      observedPrice: 0.54,
      requestedShares: 30,
      availableShares: 12,
      candidateTradeId: "trade-2",
      now: 2010,
      config
    });

    expect(exit.kind).toBe("exit");
    expect(exit.limitPrice).toBe(0.49);
    expect(exit.size).toBe(12);
  });
});

function candidateSummary(overrides: Partial<CandidateSummary> = {}): CandidateSummary {
  return {
    proxyWallet: "0xcandidate",
    userName: "candidate",
    rank: "1",
    leaderboardPnl: 0,
    leaderboardVol: 0,
    totalMarkets: 20,
    totalTrades: 40,
    wins: 12,
    losses: 8,
    breakeven: 0,
    winRate: 0.6,
    totalPnl: 100,
    totalBuy: 300,
    totalSell: 100,
    settlementValue: 300,
    roi: 0.33,
    earlyEntryRate: 0.9,
    oneSidedRate: 0.8,
    holdThroughRate: 0.7,
    averageFirstEntrySeconds: 40,
    copyabilityScore: 80,
    markets: [],
    ...overrides
  };
}
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- tests/polymarket.test.ts
```

Expected: FAIL with missing exports from `shared/copyTrader.ts` and missing types from `shared/types.ts`.

- [ ] **Step 3: Add shared copy-trader types**

Add these exports to `shared/types.ts`:

```ts
export type MarketType = "5m" | "15m";

export type CopyTraderConfig = {
  primaryMarketType: MarketType;
  fallbackMarketType: MarketType;
  latencyThresholdSeconds: number;
  activeWithinSeconds: number;
  earlyEntrySeconds: number;
  minLiveTradeUsdc: number;
  maxEntryPrice: number;
  repeatCooldownSeconds: number;
  defaultEntrySpendUsdc: number;
  maxSlippageCents: number;
};

export type MarketOutcomeMetadata = {
  name: string;
  tokenId: string;
  price?: number;
};

export type MarketMetadata = {
  conditionId: string;
  slug: string;
  title: string;
  marketType: MarketType;
  startTimestamp: number;
  endTimestamp: number;
  outcomes: MarketOutcomeMetadata[];
  minTickSize: number;
  negRisk: boolean;
};

export type SignalRecommendation = "watch" | "prepare_entry" | "prepare_exit" | "latency_degraded";
export type SignalSource = "leaderboard" | "live" | "both";

export type LiveWalletSignal = {
  wallet: string;
  name?: string;
  source: SignalSource;
  market: MarketMetadata;
  outcome: string;
  asset: string;
  side: "BUY" | "SELL";
  firstEntrySeconds: number;
  latestTradeTimestamp: number;
  latestTradeAgeSeconds: number;
  detectedAt: number;
  latencySeconds: number;
  isOneSided: boolean;
  liveTradeUsdc: number;
  observedPrice: number;
  recommendation: SignalRecommendation;
  candidateTradeId: string;
  reason: string;
};

export type LatencySample = {
  source?: string;
  marketType?: MarketType;
  latencySeconds: number;
  tradeTimestamp?: number;
  receivedAt?: number;
};

export type LatencyMode = {
  activeMarketType: MarketType;
  isDegraded: boolean;
  medianLatencySeconds: number;
};

export type SignalCooldownKey = {
  wallet: string;
  conditionId: string;
  kind: "entry" | "exit";
};

export type PreparedTradeTicket = {
  id: string;
  kind: "entry" | "exit";
  status: "pending" | "confirmed" | "submitted" | "cancelled" | "rejected";
  wallet: string;
  market: MarketMetadata;
  outcome: string;
  asset: string;
  observedPrice: number;
  limitPrice: number;
  size: number;
  spendUsdc?: number;
  availableShares?: number;
  candidateTradeId: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
};

export type CandidateFeedItem = {
  wallet: string;
  name?: string;
  source: SignalSource;
  marketType: MarketType;
  outcome: string;
  recommendation: SignalRecommendation;
  score: number;
  lastTradeAgeSeconds: number;
  latencySeconds: number;
  strictPass: boolean;
  reason: string;
  signal: LiveWalletSignal;
};

export type ExecutionLogEntry = {
  id: string;
  ticketId: string;
  status: "dry_run" | "submitted" | "rejected" | "error";
  message: string;
  response?: unknown;
  createdAt: number;
};

export type ScannerSnapshot = {
  status: "starting" | "live" | "stale" | "error";
  message: string;
  receivedAt: number;
  latency: LatencyMode;
  candidates: CandidateFeedItem[];
  tickets: PreparedTradeTicket[];
  executions: ExecutionLogEntry[];
};
```

- [ ] **Step 4: Create `shared/copyTrader.ts` with deterministic helpers**

Create `shared/copyTrader.ts` with these exports and behavior:

```ts
import type { CandidateSummary } from "./candidateScanner";
import type {
  ActivityTrade,
  CopyTraderConfig,
  LatencyMode,
  LatencySample,
  LiveWalletSignal,
  MarketMetadata,
  MarketType,
  PreparedTradeTicket,
  SignalCooldownKey
} from "./types";

const BTC_RE = /\b(bitcoin|btc)\b/i;
const FIVE_MINUTE_RE = /\b5\s*(m|min|minute)s?\b|-(5m)-/i;
const FIFTEEN_MINUTE_RE = /\b15\s*(m|min|minute)s?\b|-(15m)-/i;
const EPSILON = 1e-6;

export const DEFAULT_COPY_TRADER_CONFIG: CopyTraderConfig = {
  primaryMarketType: "5m",
  fallbackMarketType: "15m",
  latencyThresholdSeconds: 8,
  activeWithinSeconds: 20 * 60,
  earlyEntrySeconds: 90,
  minLiveTradeUsdc: 5,
  maxEntryPrice: 0.85,
  repeatCooldownSeconds: 240,
  defaultEntrySpendUsdc: 10,
  maxSlippageCents: 5
};

export function isBtcShortTermTrade(trade: Pick<ActivityTrade, "title" | "slug">, marketType?: MarketType): boolean {
  const haystack = `${trade.title} ${trade.slug}`;
  if (!BTC_RE.test(haystack)) return false;
  if (marketType === "5m") return FIVE_MINUTE_RE.test(haystack);
  if (marketType === "15m") return FIFTEEN_MINUTE_RE.test(haystack);
  return FIVE_MINUTE_RE.test(haystack) || FIFTEEN_MINUTE_RE.test(haystack);
}

export function getLatencyMode(samples: Pick<LatencySample, "latencySeconds">[], config: CopyTraderConfig): LatencyMode {
  if (samples.length === 0) {
    return { activeMarketType: config.primaryMarketType, isDegraded: false, medianLatencySeconds: 0 };
  }
  const sorted = samples.map((sample) => sample.latencySeconds).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? round((sorted[middle - 1] + sorted[middle]) / 2) : round(sorted[middle]);
  const isDegraded = median > config.latencyThresholdSeconds;
  return { activeMarketType: isDegraded ? config.fallbackMarketType : config.primaryMarketType, isDegraded, medianLatencySeconds: median };
}

export function passesStrictHistory(summary: CandidateSummary): boolean {
  return summary.totalMarkets >= 20 && summary.totalPnl > 0 && summary.winRate >= 0.6 && summary.oneSidedRate >= 0.8;
}

export function summarizeLiveWallet(
  wallet: string,
  trades: ActivityTrade[],
  market: MarketMetadata,
  now: number,
  config: CopyTraderConfig
): LiveWalletSignal | undefined {
  const sorted = trades.filter((trade) => trade.conditionId === market.conditionId).sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0) return undefined;

  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  const firstEntrySeconds = Math.max(0, first.timestamp - market.startTimestamp);
  const latestTradeAgeSeconds = Math.max(0, now - latest.timestamp);
  const liveTradeUsdc = round(sorted.filter((trade) => trade.side === "BUY").reduce((total, trade) => total + Number(trade.usdcSize || 0), 0));
  const observedPrice = Number(latest.price || first.price || 0);
  const side = latest.side === "SELL" ? "SELL" : "BUY";
  const netSharesByOutcome = new Map<string, number>();
  const buyOutcomes = new Set<string>();

  for (const trade of sorted) {
    const current = netSharesByOutcome.get(trade.outcome) ?? 0;
    const size = Number(trade.size || 0);
    if (trade.side === "BUY") {
      buyOutcomes.add(trade.outcome);
      netSharesByOutcome.set(trade.outcome, current + size);
    } else if (trade.side === "SELL") {
      netSharesByOutcome.set(trade.outcome, current - size);
    }
  }

  const nonZeroOutcomes = Array.from(netSharesByOutcome.values()).filter((shares) => Math.abs(shares) > EPSILON).length;
  const isOneSided = buyOutcomes.size <= 1 && nonZeroOutcomes <= 1;
  if (!isOneSided) return undefined;
  if (latestTradeAgeSeconds > config.activeWithinSeconds) return undefined;
  if (side === "BUY" && liveTradeUsdc < config.minLiveTradeUsdc) return undefined;
  if (side === "BUY" && observedPrice > config.maxEntryPrice) return undefined;

  const detectedAt = now;
  const latencySeconds = Math.max(0, detectedAt - latest.timestamp);
  const isEarly = firstEntrySeconds <= config.earlyEntrySeconds;
  const recommendation = side === "SELL" ? "prepare_exit" : isEarly ? "prepare_entry" : "watch";

  return {
    wallet,
    name: latest.name ?? latest.pseudonym,
    source: "live",
    market,
    outcome: latest.outcome,
    asset: latest.asset,
    side,
    firstEntrySeconds,
    latestTradeTimestamp: latest.timestamp,
    latestTradeAgeSeconds,
    detectedAt,
    latencySeconds,
    isOneSided,
    liveTradeUsdc,
    observedPrice,
    recommendation,
    candidateTradeId: activityId(latest),
    reason: `${side} ${latest.outcome} ${isEarly ? "early" : "late"} one-sided signal`
  };
}

export function shouldSuppressRepeatSignal(
  key: SignalCooldownKey,
  seen: Map<string, number>,
  now: number,
  config: CopyTraderConfig
): boolean {
  const encoded = cooldownKey(key);
  const previous = seen.get(encoded);
  if (previous !== undefined && now - previous < config.repeatCooldownSeconds) return true;
  seen.set(encoded, now);
  return false;
}

export function buildEntryTicket(input: {
  wallet: string;
  market: MarketMetadata;
  outcome: string;
  asset: string;
  observedPrice: number;
  candidateTradeId: string;
  now: number;
  config: CopyTraderConfig;
}): PreparedTradeTicket {
  const limitPrice = roundToTick(Math.min(0.99, input.observedPrice + input.config.maxSlippageCents / 100), input.market.minTickSize);
  const size = round(input.config.defaultEntrySpendUsdc / limitPrice);
  return ticket({ ...input, kind: "entry", limitPrice, size, spendUsdc: input.config.defaultEntrySpendUsdc, reason: "Confirmed entry ticket from strict live candidate" });
}

export function buildExitTicket(input: {
  wallet: string;
  market: MarketMetadata;
  outcome: string;
  asset: string;
  observedPrice: number;
  requestedShares: number;
  availableShares: number;
  candidateTradeId: string;
  now: number;
  config: CopyTraderConfig;
}): PreparedTradeTicket {
  const limitPrice = roundToTick(Math.max(0.01, input.observedPrice - input.config.maxSlippageCents / 100), input.market.minTickSize);
  const size = round(Math.min(input.requestedShares, input.availableShares));
  return ticket({ ...input, kind: "exit", limitPrice, size, availableShares: input.availableShares, reason: "Confirmed exit ticket from candidate sell signal" });
}

function ticket(input: {
  kind: "entry" | "exit";
  wallet: string;
  market: MarketMetadata;
  outcome: string;
  asset: string;
  observedPrice: number;
  limitPrice: number;
  size: number;
  spendUsdc?: number;
  availableShares?: number;
  candidateTradeId: string;
  now: number;
  reason: string;
}): PreparedTradeTicket {
  return {
    id: `${input.kind}:${input.wallet}:${input.market.conditionId}:${input.asset}:${input.candidateTradeId}`,
    kind: input.kind,
    status: "pending",
    wallet: input.wallet,
    market: input.market,
    outcome: input.outcome,
    asset: input.asset,
    observedPrice: round(input.observedPrice),
    limitPrice: input.limitPrice,
    size: input.size,
    spendUsdc: input.spendUsdc,
    availableShares: input.availableShares,
    candidateTradeId: input.candidateTradeId,
    reason: input.reason,
    createdAt: input.now,
    expiresAt: input.market.endTimestamp
  };
}

function cooldownKey(key: SignalCooldownKey): string {
  return `${key.kind}:${key.wallet}:${key.conditionId}`;
}

function activityId(trade: ActivityTrade): string {
  return [
    trade.transactionHash,
    trade.asset,
    trade.side,
    Number(trade.price).toFixed(8),
    Number(trade.size).toFixed(8),
    trade.timestamp
  ].join(":");
}

function roundToTick(value: number, tick: number): number {
  return round(Math.round(value / tick) * tick);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
```

- [ ] **Step 5: Generalize historical BTC filtering to support 5m and 15m**

In `shared/candidateScanner.ts`:

- Import `isBtcShortTermTrade` from `./copyTrader`.
- Keep `isBtcFiveMinuteTrade` as a compatibility wrapper.
- Add `isBtcFifteenMinuteTrade` and `isBtcShortTermHistoryTrade`.
- Add `marketTypes?: MarketType[]` to `CandidateOptions`.
- In `analyzeCandidate`, filter activity using the configured market types.

The final exported wrappers must be:

```ts
export function isBtcFiveMinuteTrade(trade: Pick<ActivityTrade, "title" | "slug">): boolean {
  return isBtcShortTermTrade(trade, "5m");
}

export function isBtcFifteenMinuteTrade(trade: Pick<ActivityTrade, "title" | "slug">): boolean {
  return isBtcShortTermTrade(trade, "15m");
}

export function isBtcShortTermHistoryTrade(trade: Pick<ActivityTrade, "title" | "slug">): boolean {
  return isBtcShortTermTrade(trade);
}
```

- [ ] **Step 6: Update `shared/polymarket.ts` short-term predicate to delegate**

Replace the local regex logic in `isShortTermCryptoMarket` with:

```ts
import { isBtcShortTermTrade } from "./copyTrader";

export function isShortTermCryptoMarket(position: Pick<PositionLeg, "title" | "slug">): boolean {
  const haystack = `${position.title} ${position.slug}`;
  return isBtcShortTermTrade(position) || /\b(ethereum|eth|solana|sol)\b/i.test(haystack) && /\b(5|15)\s*(m|min|minute)s?\b|-(5m|15m)-/i.test(haystack);
}
```

Format this expression with parentheses if the linter or formatter makes precedence unclear.

- [ ] **Step 7: Run tests and commit**

Run:

```bash
npm test -- tests/polymarket.test.ts
npm run build
```

Expected: both commands PASS.

Commit:

```bash
git add shared/types.ts shared/copyTrader.ts shared/candidateScanner.ts shared/polymarket.ts tests/polymarket.test.ts
git commit -m "feat: add copy trader pure logic"
```

---

### Task 2: Polymarket Client Live Market And Trade Methods

**Files:**
- Modify: `server/polymarketClient.ts`
- Modify: `shared/types.ts`
- Modify: `tests/polymarket.test.ts`

- [ ] **Step 1: Add failing tests for Gamma market parsing**

Add this import to `tests/polymarket.test.ts`:

```ts
import { marketMetadataFromGammaMarket } from "../server/polymarketClient";
```

Add this test block:

```ts
describe("Polymarket live market metadata", () => {
  it("converts Gamma market fields into scanner market metadata", () => {
    const market = marketMetadataFromGammaMarket(
      {
        question: "Bitcoin Up or Down",
        conditionId: "0xcondition",
        slug: "btc-updown-5m-1778315400",
        endDate: "2026-05-21T12:05:00Z",
        outcomes: "[\"Up\",\"Down\"]",
        outcomePrices: "[\"0.54\",\"0.46\"]",
        closed: false,
        clobTokenIds: "[\"up-token\",\"down-token\"]",
        orderPriceMinTickSize: 0.01,
        negRisk: false,
        active: true,
        acceptingOrders: true,
        startDate: "2026-05-21T12:00:00Z"
      },
      "5m"
    );

    expect(market).toEqual({
      conditionId: "0xcondition",
      slug: "btc-updown-5m-1778315400",
      title: "Bitcoin Up or Down",
      marketType: "5m",
      startTimestamp: 1779364800,
      endTimestamp: 1779365100,
      outcomes: [
        { name: "Up", tokenId: "up-token", price: 0.54 },
        { name: "Down", tokenId: "down-token", price: 0.46 }
      ],
      minTickSize: 0.01,
      negRisk: false
    });
  });
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- tests/polymarket.test.ts
```

Expected: FAIL because `marketMetadataFromGammaMarket` and extra Gamma fields do not exist.

- [ ] **Step 3: Extend `GammaMarket` type**

Add these optional fields to `GammaMarket` in `shared/types.ts`:

```ts
  clobTokenIds?: string;
  orderPriceMinTickSize?: number | string;
  negRisk?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  startDate?: string;
  eventStartTime?: string;
```

- [ ] **Step 4: Add live market helpers to `server/polymarketClient.ts`**

Update imports:

```ts
import type { ActivityTrade, GammaEvent, GammaMarket, LeaderboardTrader, MarketMetadata, MarketType, PositionLeg } from "../shared/types";
```

Add methods to `PolymarketClient`:

```ts
  async getGammaEventBySlug(slug: string): Promise<GammaEvent | undefined> {
    const url = new URL("/events", GAMMA_API);
    url.searchParams.set("slug", slug);
    const [event] = readList<GammaEvent>(await fetchJson(url));
    return event;
  }

  async getShortTermBtcMarkets(options: { marketType: MarketType; now?: number; lookbackMarkets?: number }): Promise<MarketMetadata[]> {
    const marketSeconds = options.marketType === "5m" ? 5 * 60 : 15 * 60;
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const currentStart = Math.floor(now / marketSeconds) * marketSeconds;
    const count = options.lookbackMarkets ?? 6;
    const slugs = Array.from({ length: count }, (_, index) => `btc-updown-${options.marketType}-${currentStart - index * marketSeconds}`);
    const markets = await Promise.all(slugs.map((slug) => this.getShortTermBtcMarketBySlug(slug, options.marketType)));
    return markets.filter((market): market is MarketMetadata => Boolean(market));
  }

  async getShortTermBtcMarketBySlug(slug: string, marketType: MarketType): Promise<MarketMetadata | undefined> {
    const event = await this.getGammaEventBySlug(slug);
    const market = event?.markets?.find((candidate) => candidate.slug === slug);
    return market ? marketMetadataFromGammaMarket(market, marketType) : undefined;
  }

  async getTradesByMarkets(conditionIds: string[]): Promise<ActivityTrade[]> {
    if (conditionIds.length === 0) return [];
    const url = new URL("/trades", DATA_API);
    url.searchParams.set("market", conditionIds.join(","));
    url.searchParams.set("limit", "10000");
    url.searchParams.set("takerOnly", "false");
    return readList<ActivityTrade>(await fetchJson(url));
  }
```

Add this exported helper below `readList`:

```ts
export function marketMetadataFromGammaMarket(market: GammaMarket, marketType: MarketType): MarketMetadata | undefined {
  if (!market.conditionId || market.closed || market.active === false || market.acceptingOrders === false) return undefined;

  const outcomes = readJsonArray(market.outcomes).map(String);
  const tokenIds = readJsonArray(market.clobTokenIds ?? "[]").map(String);
  const prices = readJsonArray(market.outcomePrices).map((price) => Number(price));
  if (outcomes.length === 0 || outcomes.length !== tokenIds.length) return undefined;

  const startValue = market.startDate ?? market.eventStartTime ?? getStartIsoFromSlug(market.slug);
  if (!startValue || !market.endDate) return undefined;

  return {
    conditionId: market.conditionId,
    slug: market.slug,
    title: market.question,
    marketType,
    startTimestamp: Math.floor(Date.parse(startValue) / 1000),
    endTimestamp: Math.floor(Date.parse(market.endDate) / 1000),
    outcomes: outcomes.map((name, index) => ({ name, tokenId: tokenIds[index], price: prices[index] })),
    minTickSize: Number(market.orderPriceMinTickSize ?? 0.01),
    negRisk: Boolean(market.negRisk)
  };
}

function readJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getStartIsoFromSlug(slug: string): string | undefined {
  const match = slug.match(/-(\d+)$/);
  return match ? new Date(Number(match[1]) * 1000).toISOString() : undefined;
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/polymarket.test.ts
npm run build
```

Expected: both commands PASS.

Commit:

```bash
git add server/polymarketClient.ts shared/types.ts tests/polymarket.test.ts
git commit -m "feat: add live Polymarket market client helpers"
```

---

### Task 3: Scanner Service And Candidate Promotion

**Files:**
- Create: `server/scannerService.ts`
- Modify: `server/index.ts`
- Modify: `tests/polymarket.test.ts`

- [ ] **Step 1: Add scanner service tests with mocked client**

Add this import to the existing import section at the top of `tests/polymarket.test.ts`:

```ts
import { ScannerService } from "../server/scannerService";
```

Add this test block before helper functions:

```ts
describe("scanner service", () => {
  it("promotes strict live candidates and creates entry tickets", async () => {
    const market: MarketMetadata = {
      conditionId: "0xscan",
      slug: "btc-updown-5m-3000",
      title: "Bitcoin Up or Down",
      marketType: "5m",
      startTimestamp: 3000,
      endTimestamp: 3300,
      outcomes: [{ name: "Up", tokenId: "up-token", price: 0.54 }],
      minTickSize: 0.01,
      negRisk: false
    };

    const service = new ScannerService({
      now: () => 3020,
      intervalMs: 60_000,
      client: {
        getShortTermBtcMarkets: async () => [market],
        getTradesByMarkets: async () => [
          trade({
            proxyWallet: "0x1111111111111111111111111111111111111111",
            conditionId: "0xscan",
            slug: market.slug,
            title: market.title,
            timestamp: 3010,
            outcome: "Up",
            asset: "up-token",
            size: 30,
            usdcSize: 16.2,
            price: 0.54
          })
        ],
        getLeaderboardTraders: async () => [],
        getActivityRange: async () => [],
        getGammaMarketBySlug: async () => undefined
      },
      summarizeHistory: async () => candidateSummary({ proxyWallet: "0x1111111111111111111111111111111111111111" })
    });

    await service.scanOnce();
    const snapshot = service.getSnapshot();

    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0].recommendation).toBe("prepare_entry");
    expect(snapshot.tickets).toHaveLength(1);
    expect(snapshot.tickets[0].limitPrice).toBe(0.59);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- tests/polymarket.test.ts
```

Expected: FAIL because `ScannerService` does not exist.

- [ ] **Step 3: Create `server/scannerService.ts`**

Implement these public surfaces exactly:

```ts
import { analyzeCandidate } from "../shared/candidateScanner";
import {
  DEFAULT_COPY_TRADER_CONFIG,
  buildEntryTicket,
  getLatencyMode,
  passesStrictHistory,
  shouldSuppressRepeatSignal,
  summarizeLiveWallet
} from "../shared/copyTrader";
import type {
  ActivityTrade,
  CandidateFeedItem,
  CopyTraderConfig,
  ExecutionLogEntry,
  LatencySample,
  MarketMetadata,
  MarketType,
  PreparedTradeTicket,
  ScannerSnapshot
} from "../shared/types";
import { PolymarketClient } from "./polymarketClient";

type ScannerClient = Pick<PolymarketClient, "getShortTermBtcMarkets" | "getTradesByMarkets" | "getLeaderboardTraders" | "getActivityRange" | "getGammaMarketBySlug">;
type Subscriber = (snapshot: ScannerSnapshot) => void;

type ScannerServiceOptions = {
  client?: ScannerClient;
  config?: CopyTraderConfig;
  intervalMs?: number;
  now?: () => number;
  summarizeHistory?: (wallet: string, signalTrades: ActivityTrade[]) => Promise<ReturnType<typeof analyzeCandidate>>;
};

export class ScannerService {
  private readonly client: ScannerClient;
  private readonly config: CopyTraderConfig;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly summarizeHistoryOverride?: ScannerServiceOptions["summarizeHistory"];
  private readonly subscribers = new Set<Subscriber>();
  private readonly latencySamples: LatencySample[] = [];
  private readonly cooldowns = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private snapshot: ScannerSnapshot;

  constructor(options: ScannerServiceOptions = {}) {
    this.client = options.client ?? new PolymarketClient();
    this.config = options.config ?? DEFAULT_COPY_TRADER_CONFIG;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.summarizeHistoryOverride = options.summarizeHistory;
    this.snapshot = {
      status: "starting",
      message: "Scanner starting",
      receivedAt: Date.now(),
      latency: getLatencyMode([], this.config),
      candidates: [],
      tickets: [],
      executions: []
    };
  }

  start(): void {
    if (this.timer) return;
    void this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.snapshot);
    return () => this.subscribers.delete(subscriber);
  }

  getSnapshot(): ScannerSnapshot {
    return this.snapshot;
  }

  cancelTicket(id: string): PreparedTradeTicket | undefined {
    const ticket = this.snapshot.tickets.find((item) => item.id === id);
    if (!ticket) return undefined;
    ticket.status = "cancelled";
    this.publish("live", "Ticket cancelled");
    return ticket;
  }

  recordExecution(entry: ExecutionLogEntry): void {
    this.snapshot.executions = [entry, ...this.snapshot.executions].slice(0, 100);
    this.publish("live", "Execution updated");
  }

  markTicketSubmitted(id: string): void {
    const ticket = this.snapshot.tickets.find((item) => item.id === id);
    if (ticket) ticket.status = "submitted";
    this.publish("live", "Ticket submitted");
  }

  async scanOnce(): Promise<void> {
    try {
      const latency = getLatencyMode(this.latencySamples.slice(-20), this.config);
      const markets = await this.client.getShortTermBtcMarkets({ marketType: latency.activeMarketType, lookbackMarkets: latency.activeMarketType === "5m" ? 8 : 4 });
      const trades = await this.client.getTradesByMarkets(markets.map((market) => market.conditionId));
      const candidates = await this.promoteCandidates(markets, trades);
      this.snapshot = {
        ...this.snapshot,
        status: "live",
        message: latency.isDegraded ? "BTC 5m latency degraded; scanning BTC 15m" : "Scanning BTC 5m",
        receivedAt: Date.now(),
        latency,
        candidates
      };
      this.notify();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish("error", message);
    }
  }

  private async promoteCandidates(markets: MarketMetadata[], trades: ActivityTrade[]): Promise<CandidateFeedItem[]> {
    const now = this.now();
    const marketByCondition = new Map(markets.map((market) => [market.conditionId, market]));
    const byWalletAndMarket = new Map<string, ActivityTrade[]>();

    for (const trade of trades) {
      const market = marketByCondition.get(trade.conditionId);
      if (!market) continue;
      this.latencySamples.push({ source: "market_trades", marketType: market.marketType, latencySeconds: Math.max(0, now - trade.timestamp), tradeTimestamp: trade.timestamp, receivedAt: now });
      const key = `${trade.proxyWallet}:${trade.conditionId}`;
      const group = byWalletAndMarket.get(key) ?? [];
      group.push(trade);
      byWalletAndMarket.set(key, group);
    }

    const promoted: CandidateFeedItem[] = [];

    for (const [key, walletTrades] of byWalletAndMarket) {
      const [wallet, conditionId] = key.split(":");
      const market = marketByCondition.get(conditionId);
      if (!market) continue;
      const signal = summarizeLiveWallet(wallet, walletTrades, market, now, this.config);
      if (!signal) continue;
      const kind = signal.recommendation === "prepare_exit" ? "exit" : "entry";
      if (shouldSuppressRepeatSignal({ wallet, conditionId, kind }, this.cooldowns, now, this.config)) continue;
      const history = await this.summarizeHistory(wallet, walletTrades);
      const strictPass = passesStrictHistory(history);
      if (!strictPass) continue;

      promoted.push({
        wallet,
        name: signal.name,
        source: signal.source,
        marketType: market.marketType,
        outcome: signal.outcome,
        recommendation: signal.recommendation,
        score: history.copyabilityScore,
        lastTradeAgeSeconds: signal.latestTradeAgeSeconds,
        latencySeconds: signal.latencySeconds,
        strictPass,
        reason: signal.reason,
        signal
      });

      if (signal.recommendation === "prepare_entry") {
        const ticket = buildEntryTicket({
          wallet,
          market,
          outcome: signal.outcome,
          asset: signal.asset,
          observedPrice: signal.observedPrice,
          candidateTradeId: signal.candidateTradeId,
          now,
          config: this.config
        });
        if (!this.snapshot.tickets.some((existing) => existing.id === ticket.id)) {
          this.snapshot.tickets = [ticket, ...this.snapshot.tickets].slice(0, 50);
        }
      }
    }

    return promoted.sort((a, b) => b.score - a.score || a.latencySeconds - b.latencySeconds);
  }

  private async summarizeHistory(wallet: string, signalTrades: ActivityTrade[]): Promise<ReturnType<typeof analyzeCandidate>> {
    if (this.summarizeHistoryOverride) return this.summarizeHistoryOverride(wallet, signalTrades);
    const end = this.now();
    const start = end - 7 * 24 * 60 * 60;
    const activity = await this.client.getActivityRange(wallet, start, end);
    const winners = await this.loadWinners(activity);
    return analyzeCandidate({ proxyWallet: wallet, rank: "", pnl: 0, vol: 0 }, activity, winners, { marketTypes: ["5m", "15m"], earlyEntrySeconds: this.config.earlyEntrySeconds });
  }

  private async loadWinners(activity: ActivityTrade[]): Promise<Map<string, string>> {
    const winners = new Map<string, string>();
    const firstTradeByCondition = new Map<string, ActivityTrade>();
    for (const trade of activity) {
      if (!firstTradeByCondition.has(trade.conditionId)) firstTradeByCondition.set(trade.conditionId, trade);
    }

    await Promise.all(
      Array.from(firstTradeByCondition.values()).map(async (trade) => {
        const market = await this.client.getGammaMarketBySlug(trade.slug);
        const winner = market ? getWinningOutcome(market) : undefined;
        if (winner) winners.set(trade.conditionId, winner);
      })
    );

    return winners;
  }

  private publish(status: ScannerSnapshot["status"], message: string): void {
    this.snapshot = { ...this.snapshot, status, message, receivedAt: Date.now() };
    this.notify();
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber(this.snapshot);
  }
}

function getWinningOutcome(market: { closed: boolean; outcomes: string; outcomePrices: string }): string | undefined {
  if (!market.closed) return undefined;
  const outcomes = readJsonArray(market.outcomes).map(String);
  const prices = readJsonArray(market.outcomePrices).map((price) => Number(price));
  if (outcomes.length === 0 || outcomes.length !== prices.length) return undefined;
  const winningIndex = prices.findIndex((price) => price === Math.max(...prices));
  return prices[winningIndex] >= 0.99 ? outcomes[winningIndex] : undefined;
}

function readJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Wire scanner lifecycle into Express**

In `server/index.ts`, instantiate `ScannerService` once:

```ts
import { ScannerService } from "./scannerService";

const scannerService = new ScannerService();
scannerService.start();
```

Do not expose routes yet in this task.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/polymarket.test.ts
npm run build
```

Expected: both commands PASS.

Commit:

```bash
git add server/scannerService.ts server/index.ts tests/polymarket.test.ts
git commit -m "feat: add scanner service"
```

---

### Task 4: Trading Bridge And Confirmed Ticket Execution

**Files:**
- Create: `trading/bridge/execute_ticket.py`
- Create: `trading/bridge/babygain_bridge/__init__.py`
- Create: `trading/bridge/babygain_bridge/config.py`
- Create: `trading/bridge/babygain_bridge/trader.py`
- Create: `trading/requirements.txt`
- Create: `server/tradingProvider.ts`
- Modify: `.gitignore`
- Modify: `tests/polymarket.test.ts`

- [ ] **Step 1: Add bridge provider tests**

Add this import:

```ts
import { buildTradingProviderCommand, parseTradingProviderResponse } from "../server/tradingProvider";
```

Add this test block:

```ts
describe("trading provider bridge", () => {
  it("builds a local Python bridge command without leaking secrets", () => {
    const command = buildTradingProviderCommand();
    expect(command.command).toMatch(/python/);
    expect(command.args).toContain("trading/bridge/execute_ticket.py");
    expect(JSON.stringify(command)).not.toMatch(/POLYMARKET_PRIVATE_KEY|POLYMARKET_API_SECRET/);
  });

  it("parses bridge JSON responses", () => {
    expect(parseTradingProviderResponse('{"status":"dry_run","message":"ok","response":{"id":"abc"}}')).toEqual({
      status: "dry_run",
      message: "ok",
      response: { id: "abc" }
    });
    expect(() => parseTradingProviderResponse("not json")).toThrow(/Invalid trading bridge response/);
  });
});
```

- [ ] **Step 2: Copy and adapt Python config**

Copy the dotenv, env parsing, and live validation logic from `/private/tmp/polymarket-babygain/src/babygain_bot/config.py` into `trading/bridge/babygain_bridge/config.py`.

Change the dataclass name to `BridgeConfig` and use these fields:

```py
@dataclass(frozen=True)
class BridgeConfig:
    dry_run: bool = True
    clob_host: str = "https://clob.polymarket.com"
    chain_id: int = 137
    private_key: str | None = None
    api_key: str | None = None
    api_secret: str | None = None
    api_passphrase: str | None = None
    signature_type: int | None = None
    funder_address: str | None = None
```

Load environment variables:

- `COPY_TRADER_DRY_RUN`, default `true`.
- `POLYMARKET_CLOB_HOST`, default `https://clob.polymarket.com`.
- `POLYMARKET_CHAIN_ID`, default `137`.
- `POLYMARKET_PRIVATE_KEY`.
- `POLYMARKET_API_KEY`.
- `POLYMARKET_API_SECRET`.
- `POLYMARKET_API_PASSPHRASE`.
- `POLYMARKET_SIGNATURE_TYPE`, default `0`.
- `POLYMARKET_FUNDER_ADDRESS`.

Validation:

- Dry-run skips private key validation.
- Live mode requires `POLYMARKET_PRIVATE_KEY`.
- Signature types `1`, `2`, and `3` require `POLYMARKET_FUNDER_ADDRESS`.

Expose these methods on `BridgeConfig`:

```py
@classmethod
def from_env(cls) -> "BridgeConfig":
    load_dotenv()
    return cls(
        dry_run=env_bool("COPY_TRADER_DRY_RUN", True),
        clob_host=os.getenv("POLYMARKET_CLOB_HOST", "https://clob.polymarket.com"),
        chain_id=env_int("POLYMARKET_CHAIN_ID", 137),
        private_key=os.getenv("POLYMARKET_PRIVATE_KEY") or None,
        api_key=os.getenv("POLYMARKET_API_KEY") or None,
        api_secret=os.getenv("POLYMARKET_API_SECRET") or None,
        api_passphrase=os.getenv("POLYMARKET_API_PASSPHRASE") or None,
        signature_type=env_int("POLYMARKET_SIGNATURE_TYPE", 0),
        funder_address=os.getenv("POLYMARKET_FUNDER_ADDRESS") or None,
    )

def validate_for_live(self) -> None:
    if self.dry_run:
        return
    if not self.private_key:
        raise ValueError("POLYMARKET_PRIVATE_KEY is required for live trading.")
    if self.signature_type in {1, 2, 3} and not self.funder_address:
        raise ValueError(f"POLYMARKET_FUNDER_ADDRESS is required when POLYMARKET_SIGNATURE_TYPE={self.signature_type}.")
```

- [ ] **Step 3: Copy and adapt Python trader**

Copy the resilient constructor helpers and GTD execution logic from `/private/tmp/polymarket-babygain/src/babygain_bot/trader.py` into `trading/bridge/babygain_bridge/trader.py`.

Expose this dataclass and class API:

```py
@dataclass(frozen=True)
class BridgeTicket:
    id: str
    token_id: str
    side: str
    price: float
    size: float
    tick_size: float
    neg_risk: bool
    expires_at: int
```

The class must be named `BridgeTrader`, accept `BridgeConfig` in its constructor, and expose `submit(self, ticket: BridgeTicket) -> dict[str, Any]`.

Behavior:

- If `config.dry_run` is true, return `{"dry_run": True, "ticket": asdict(ticket)}`.
- For live mode, use `py_clob_client_v2` to create and post a GTD order.
- Map ticket side `"BUY"` or `"SELL"` to `models["Side"].BUY` or `models["Side"].SELL`.
- Use `ticket.price`, `ticket.size`, `ticket.token_id`, `ticket.tick_size`, `ticket.neg_risk`, and `ticket.expires_at`.
- Preserve the helpful auth mismatch errors from the prior repo.

- [ ] **Step 4: Create Python stdin/stdout executable**

Create `trading/bridge/execute_ticket.py`:

```py
from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from babygain_bridge.config import BridgeConfig
from babygain_bridge.trader import BridgeTicket, BridgeTrader


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
        config = BridgeConfig.from_env()
        config.validate_for_live()
        ticket = BridgeTicket(
            id=str(payload["id"]),
            token_id=str(payload["token_id"]),
            side=str(payload["side"]).upper(),
            price=float(payload["price"]),
            size=float(payload["size"]),
            tick_size=float(payload["tick_size"]),
            neg_risk=bool(payload["neg_risk"]),
            expires_at=int(payload["expires_at"]),
        )
        response = BridgeTrader(config).submit(ticket)
        status = "dry_run" if config.dry_run else "submitted"
        print(json.dumps({"status": status, "message": "ok", "ticket": asdict(ticket), "response": response}, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Add Python requirements and ignore local runtime files**

Create `trading/requirements.txt`:

```txt
py-clob-client-v2>=0.1.0
python-dotenv>=1.0.0
```

Add to `.gitignore`:

```gitignore
.env
.venv/
trading/.venv/
```

- [ ] **Step 6: Create TypeScript trading provider**

Create `server/tradingProvider.ts`:

```ts
import { spawn } from "node:child_process";
import type { ExecutionLogEntry, PreparedTradeTicket } from "../shared/types";

export type TradingProviderResponse = {
  status: "dry_run" | "submitted" | "rejected" | "error";
  message: string;
  response?: unknown;
};

export type TradingProvider = {
  submit(ticket: PreparedTradeTicket): Promise<TradingProviderResponse>;
  status(): { mode: "dry_run" | "live"; ready: boolean; message: string };
};

export function buildTradingProviderCommand(): { command: string; args: string[] } {
  return { command: process.env.PYTHON_BIN ?? "python3", args: ["trading/bridge/execute_ticket.py"] };
}

export function parseTradingProviderResponse(raw: string): TradingProviderResponse {
  try {
    const parsed = JSON.parse(raw) as TradingProviderResponse;
    if (!parsed || typeof parsed.status !== "string" || typeof parsed.message !== "string") {
      throw new Error("missing status/message");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid trading bridge response: ${raw.slice(0, 300)}`);
  }
}

export class PythonTradingProvider implements TradingProvider {
  status(): { mode: "dry_run" | "live"; ready: boolean; message: string } {
    const live = process.env.COPY_TRADER_DRY_RUN === "false";
    if (!live) return { mode: "dry_run", ready: true, message: "Dry-run trading bridge ready" };
    if (!process.env.POLYMARKET_PRIVATE_KEY) return { mode: "live", ready: false, message: "POLYMARKET_PRIVATE_KEY is required for live trading" };
    return { mode: "live", ready: true, message: "Live trading bridge configured" };
  }

  submit(ticket: PreparedTradeTicket): Promise<TradingProviderResponse> {
    const command = buildTradingProviderCommand();
    const side = ticket.kind === "entry" ? "BUY" : "SELL";
    const payload = JSON.stringify({
      id: ticket.id,
      token_id: ticket.asset,
      side,
      price: ticket.limitPrice,
      size: ticket.size,
      tick_size: ticket.market.minTickSize,
      neg_risk: ticket.market.negRisk,
      expires_at: ticket.expiresAt
    });

    return new Promise((resolve, reject) => {
      const child = spawn(command.command, command.args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", () => {
        try {
          const parsed = parseTradingProviderResponse(stdout.trim());
          if (parsed.status === "error" && stderr) parsed.response = { stderr };
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(payload);
    });
  }
}

export function executionFromProviderResponse(ticket: PreparedTradeTicket, result: TradingProviderResponse): ExecutionLogEntry {
  return {
    id: `${ticket.id}:${Date.now()}`,
    ticketId: ticket.id,
    status: result.status,
    message: result.message,
    response: result.response,
    createdAt: Date.now()
  };
}
```

- [ ] **Step 7: Run tests and bridge dry-run smoke test**

Run:

```bash
npm test -- tests/polymarket.test.ts
npm run build
printf '{"id":"dry","token_id":"token","side":"BUY","price":0.5,"size":5,"tick_size":0.01,"neg_risk":false,"expires_at":1779365100}' | python3 trading/bridge/execute_ticket.py
```

Expected:

- `npm test` PASS.
- `npm run build` PASS.
- Python command prints JSON with `"status": "dry_run"`.

Commit:

```bash
git add .gitignore trading/requirements.txt trading/bridge server/tradingProvider.ts tests/polymarket.test.ts
git commit -m "feat: add Python trading bridge"
```

---

### Task 5: Scanner API Routes And Ticket Confirmation

**Files:**
- Create: `server/scannerRoutes.ts`
- Modify: `server/index.ts`
- Modify: `server/scannerService.ts`
- Modify: `tests/polymarket.test.ts`

- [ ] **Step 1: Add route-level behavior tests for pure handlers**

Rather than testing Express sockets directly in the first pass, add tests around route helper functions exported from `server/scannerRoutes.ts`:

```ts
import { confirmTicket, scannerEventPayload } from "../server/scannerRoutes";
```

Add:

```ts
describe("scanner routes", () => {
  it("serializes scanner SSE payloads", () => {
    const payload = scannerEventPayload({ status: "live", message: "ok", receivedAt: 1, latency: { activeMarketType: "5m", isDegraded: false, medianLatencySeconds: 3 }, candidates: [], tickets: [], executions: [] });
    expect(payload).toBe('event: scanner_snapshot\ndata: {"status":"live","message":"ok","receivedAt":1,"latency":{"activeMarketType":"5m","isDegraded":false,"medianLatencySeconds":3},"candidates":[],"tickets":[],"executions":[]}\n\n');
  });
});
```

- [ ] **Step 2: Create `server/scannerRoutes.ts`**

Implement:

```ts
import type { Express, Response } from "express";
import type { PreparedTradeTicket, ScannerSnapshot } from "../shared/types";
import type { ScannerService } from "./scannerService";
import { PythonTradingProvider, executionFromProviderResponse, type TradingProvider } from "./tradingProvider";

export function scannerEventPayload(snapshot: ScannerSnapshot): string {
  return `event: scanner_snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export function registerScannerRoutes(app: Express, scanner: ScannerService, tradingProvider: TradingProvider = new PythonTradingProvider()): void {
  app.get("/api/scanner/stream", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const unsubscribe = scanner.subscribe((snapshot) => response.write(scannerEventPayload(snapshot)));
    request.on("close", unsubscribe);
  });

  app.get("/api/candidates", (_request, response) => {
    response.json(scanner.getSnapshot());
  });

  app.get("/api/trading/status", (_request, response) => {
    response.json(tradingProvider.status());
  });

  app.post("/api/tickets/:id/cancel", (request, response) => {
    const ticket = scanner.cancelTicket(request.params.id);
    if (!ticket) {
      response.status(404).json({ error: "Ticket not found" });
      return;
    }
    response.json(ticket);
  });

  app.post("/api/tickets/:id/confirm", async (request, response) => {
    try {
      const result = await confirmTicket(scanner, tradingProvider, request.params.id);
      if (!result) {
        response.status(404).json({ error: "Ticket not found" });
        return;
      }
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function confirmTicket(scanner: ScannerService, tradingProvider: TradingProvider, id: string): Promise<{ ticket: PreparedTradeTicket; execution: ReturnType<typeof executionFromProviderResponse> } | undefined> {
  const ticket = scanner.getSnapshot().tickets.find((candidate) => candidate.id === id && candidate.status === "pending");
  if (!ticket) return undefined;
  ticket.status = "confirmed";
  const result = await tradingProvider.submit(ticket);
  const execution = executionFromProviderResponse(ticket, result);
  scanner.recordExecution(execution);
  scanner.markTicketSubmitted(ticket.id);
  return { ticket, execution };
}
```

- [ ] **Step 3: Wire routes in `server/index.ts`**

Add:

```ts
import { registerScannerRoutes } from "./scannerRoutes";

app.use(express.json());
registerScannerRoutes(app, scannerService);
```

Place `app.use(express.json())` before route registration.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- tests/polymarket.test.ts
npm run build
```

Expected: both PASS.

Commit:

```bash
git add server/scannerRoutes.ts server/index.ts server/scannerService.ts tests/polymarket.test.ts
git commit -m "feat: add scanner API routes"
```

---

### Task 6: Scanner GUI Workspace

**Files:**
- Create: `src/scannerApi.ts`
- Modify: `src/main.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Create client API helper**

Create `src/scannerApi.ts`:

```ts
import type { ScannerSnapshot } from "../shared/types";

export function connectScannerStream(onSnapshot: (snapshot: ScannerSnapshot) => void, onError: (message: string) => void): EventSource {
  const source = new EventSource("/api/scanner/stream");
  source.addEventListener("scanner_snapshot", (event) => {
    onSnapshot(JSON.parse((event as MessageEvent).data) as ScannerSnapshot);
  });
  source.onerror = () => onError("Scanner stream reconnecting");
  return source;
}

export async function confirmTicket(id: string): Promise<void> {
  const response = await fetch(`/api/tickets/${encodeURIComponent(id)}/confirm`, { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
}

export async function cancelTicket(id: string): Promise<void> {
  const response = await fetch(`/api/tickets/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
}
```

- [ ] **Step 2: Add scanner state to `src/main.tsx`**

Import:

```ts
import { CheckCircle2, Clock3, RadioTower, Send, ShieldCheck, XCircle } from "lucide-react";
import { cancelTicket, confirmTicket, connectScannerStream } from "./scannerApi";
import type { CandidateFeedItem, PreparedTradeTicket, ScannerSnapshot } from "../shared/types";
```

Add state inside `App`:

```ts
  const [scannerSnapshot, setScannerSnapshot] = React.useState<ScannerSnapshot | null>(null);
  const [selectedCandidateWallet, setSelectedCandidateWallet] = React.useState<string | null>(null);
```

Add effect:

```ts
  React.useEffect(() => {
    const source = connectScannerStream(setScannerSnapshot, (message) => {
      setError({ message, receivedAt: Date.now() });
    });
    return () => source.close();
  }, []);
```

- [ ] **Step 3: Render scanner panels above the current tracker grid**

Insert after the metrics grid:

```tsx
      <section className="scanner-grid">
        <CandidateFeed
          snapshot={scannerSnapshot}
          selectedWallet={selectedCandidateWallet}
          onSelect={(candidate) => {
            setSelectedCandidateWallet(candidate.wallet);
            setSelectedWallet(candidate.wallet);
          }}
        />
        <TicketQueue
          tickets={scannerSnapshot?.tickets ?? []}
          onConfirm={(id) => confirmTicket(id).catch((error) => setError({ message: error.message, receivedAt: Date.now() }))}
          onCancel={(id) => cancelTicket(id).catch((error) => setError({ message: error.message, receivedAt: Date.now() }))}
        />
        <ExecutionLog entries={scannerSnapshot?.executions ?? []} />
      </section>
```

Add components below `PositionTable`:

```tsx
function CandidateFeed({
  snapshot,
  selectedWallet,
  onSelect
}: {
  snapshot: ScannerSnapshot | null;
  selectedWallet: string | null;
  onSelect: (candidate: CandidateFeedItem) => void;
}) {
  const candidates = snapshot?.candidates ?? [];
  return (
    <section className="scanner-panel candidate-feed">
      <header className="panel-header">
        <h2>Candidate feed</h2>
        <span>{snapshot ? `${snapshot.latency.activeMarketType} active / ${snapshot.latency.medianLatencySeconds}s latency` : "Starting scanner"}</span>
      </header>
      <div className="candidate-list">
        {candidates.length === 0 ? <EmptyState text="No strict candidates right now." /> : null}
        {candidates.map((candidate) => (
          <button
            className={candidate.wallet === selectedWallet ? "candidate-row active" : "candidate-row"}
            key={`${candidate.wallet}:${candidate.signal.market.conditionId}:${candidate.signal.candidateTradeId}`}
            onClick={() => onSelect(candidate)}
          >
            <div>
              <strong>{walletLabel(candidate.wallet)}</strong>
              <span>{candidate.signal.market.title}</span>
            </div>
            <div className="candidate-badges">
              <Badge>{candidate.marketType}</Badge>
              <Badge>{candidate.source}</Badge>
              <Badge>{candidate.recommendation.replace("_", " ")}</Badge>
              {candidate.strictPass ? <Badge>strict pass</Badge> : null}
            </div>
            <div className="candidate-stats">
              <span>Score {candidate.score.toFixed(1)}</span>
              <span>{candidate.outcome}</span>
              <span>{candidate.latencySeconds}s lag</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function TicketQueue({ tickets, onConfirm, onCancel }: { tickets: PreparedTradeTicket[]; onConfirm: (id: string) => void; onCancel: (id: string) => void }) {
  return (
    <section className="scanner-panel ticket-queue">
      <header className="panel-header">
        <h2>Trade tickets</h2>
        <span>{tickets.filter((ticket) => ticket.status === "pending").length} pending</span>
      </header>
      <div className="ticket-list">
        {tickets.length === 0 ? <EmptyState text="Prepared tickets appear here." /> : null}
        {tickets.map((ticket) => (
          <article className="ticket-card" key={ticket.id}>
            <div>
              <strong>{ticket.kind.toUpperCase()} {ticket.outcome}</strong>
              <span>{ticket.market.title}</span>
            </div>
            <div className="ticket-meta">
              <span>limit {formatPercent(ticket.limitPrice)}</span>
              <span>{formatNumber(ticket.size)} shares</span>
              {ticket.spendUsdc ? <span>{formatCurrency(ticket.spendUsdc)}</span> : null}
              <span>{ticket.status}</span>
            </div>
            <div className="ticket-actions">
              <button onClick={() => onConfirm(ticket.id)} disabled={ticket.status !== "pending"} title="Confirm ticket" aria-label="Confirm ticket">
                <Send size={16} />
              </button>
              <button onClick={() => onCancel(ticket.id)} disabled={ticket.status !== "pending"} title="Cancel ticket" aria-label="Cancel ticket">
                <XCircle size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ExecutionLog({ entries }: { entries: ScannerSnapshot["executions"] }) {
  return (
    <section className="scanner-panel execution-log">
      <header className="panel-header">
        <h2>Execution log</h2>
        <span>{entries.length} events</span>
      </header>
      <div className="execution-list">
        {entries.length === 0 ? <EmptyState text="Confirmed orders will log here." /> : null}
        {entries.map((entry) => (
          <article className="execution-row" key={entry.id}>
            <strong>{entry.status}</strong>
            <span>{entry.message}</span>
            <span>{relativeTime(entry.createdAt)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="badge">{children}</span>;
}
```

- [ ] **Step 4: Add scanner styles**

Append to `src/styles.css`:

```css
.scanner-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr) minmax(260px, 0.7fr);
  gap: 16px;
  align-items: start;
  margin-bottom: 16px;
}

.scanner-panel {
  min-height: 260px;
  overflow: hidden;
  background: rgba(21, 26, 34, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
}

.candidate-list,
.ticket-list,
.execution-list {
  display: flex;
  flex-direction: column;
  max-height: 360px;
  overflow: auto;
}

.candidate-row {
  width: 100%;
  padding: 14px 16px;
  border: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  background: transparent;
  color: #edf2f8;
  text-align: left;
}

.candidate-row.active,
.candidate-row:hover {
  background: rgba(156, 215, 255, 0.1);
}

.candidate-row strong,
.candidate-row span,
.ticket-card strong,
.ticket-card span,
.execution-row strong,
.execution-row span {
  display: block;
}

.candidate-row div:first-child span,
.ticket-card div:first-child span,
.execution-row span {
  color: #98a8ba;
  font-size: 0.82rem;
}

.candidate-badges,
.candidate-stats,
.ticket-meta,
.ticket-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.badge,
.candidate-stats span,
.ticket-meta span {
  padding: 4px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  color: #b9c7d6;
  font-size: 0.78rem;
}

.ticket-card,
.execution-row {
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.ticket-actions button {
  width: 34px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #edf2f8;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ticket-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

@media (max-width: 1200px) {
  .scanner-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 5: Run frontend build**

Run:

```bash
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/scannerApi.ts src/main.tsx src/styles.css
git commit -m "feat: add scanner workspace UI"
```

---

### Task 7: Latency Diagnostic Script

**Files:**
- Create: `scripts/diagnoseLatency.ts`
- Modify: `package.json`

- [ ] **Step 1: Create diagnostic script**

Create `scripts/diagnoseLatency.ts`:

```ts
import { PolymarketClient } from "../server/polymarketClient";

const client = new PolymarketClient();

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const markets = await client.getShortTermBtcMarkets({ marketType: "5m", now, lookbackMarkets: 4 });
  const trades = await client.getTradesByMarkets(markets.map((market) => market.conditionId));
  const newest = [...trades].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
  const rows = [];

  for (const trade of newest) {
    const activity = await client.getActivity(trade.proxyWallet);
    const activityMatch = activity.find((candidate) => candidate.transactionHash === trade.transactionHash && candidate.asset === trade.asset);
    rows.push({
      wallet: trade.proxyWallet,
      market: trade.slug,
      side: trade.side,
      outcome: trade.outcome,
      tradeAgeSeconds: now - trade.timestamp,
      appearsInActivity: Boolean(activityMatch),
      activityNewestAgeSeconds: activity[0] ? now - activity[0].timestamp : undefined
    });
  }

  console.table(rows);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 2: Add package script**

In `package.json`, add:

```json
"scan:latency": "tsx scripts/diagnoseLatency.ts"
```

- [ ] **Step 3: Run static checks and optionally the live diagnostic**

Run:

```bash
npm run build
```

Expected: PASS.

If network is available and rate limits are quiet, run:

```bash
npm run scan:latency
```

Expected: table prints recent BTC 5m market trades and whether each appears in wallet activity.

Commit:

```bash
git add scripts/diagnoseLatency.ts package.json
git commit -m "feat: add Polymarket latency diagnostic"
```

---

### Task 8: End-To-End Verification And Local Run

**Files:**
- All touched files

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run full TypeScript/Vite build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Smoke-test Python bridge in dry-run**

Run:

```bash
printf '{"id":"dry","token_id":"token","side":"BUY","price":0.5,"size":5,"tick_size":0.01,"neg_risk":false,"expires_at":1779365100}' | python3 trading/bridge/execute_ticket.py
```

Expected: JSON includes `"status": "dry_run"` and echoes the ticket.

- [ ] **Step 4: Start the app**

Run:

```bash
npm run dev
```

Expected:

- Express API listens on `http://127.0.0.1:5174`.
- Vite client listens on `http://127.0.0.1:5173`.
- Browser shows candidate feed, ticket queue, execution log, and existing wallet tracker.

- [ ] **Step 5: Browser verification**

Open `http://127.0.0.1:5173` and verify:

- Candidate feed renders without layout overlap.
- Latency state renders even when there are no candidates.
- Existing wallet tabs and trade tape still work.
- A dry-run ticket can be confirmed if the scanner creates one.
- Cancel buttons only affect pending tickets.

- [ ] **Step 6: Final commit if previous tasks left changes**

Run:

```bash
git status --short
```

If there are tracked implementation changes, commit them:

```bash
git add .
git commit -m "chore: verify hybrid copy trader gui"
```

Do not commit `.env`, `.venv/`, `node_modules/`, `.superpowers/`, `dist/`, or generated reports.
