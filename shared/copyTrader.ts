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
  primaryMarketType: "15m",
  fallbackMarketType: "15m",
  latencyThresholdSeconds: 8,
  activeWithinSeconds: 20 * 60,
  earlyEntrySeconds: 90,
  minLiveTradeUsdc: 100,
  maxEntryPrice: 0.85,
  repeatCooldownSeconds: 240,
  defaultEntrySpendUsdc: 10,
  maxSlippageCents: 5,
  minHistoryVolume: 100
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

  return {
    activeMarketType: isDegraded ? config.fallbackMarketType : config.primaryMarketType,
    isDegraded,
    medianLatencySeconds: median
  };
}

export function passesStrictHistory(summary: CandidateSummary, minHistoryVolume = 100): boolean {
  return summary.totalMarkets >= 20 && summary.totalPnl > 0 && summary.winRate >= 0.6 && summary.oneSidedRate >= 0.8 && summary.totalBuy >= minHistoryVolume;
}

export function summarizeLiveWallet(
  wallet: string,
  trades: ActivityTrade[],
  market: MarketMetadata,
  now: number,
  config: CopyTraderConfig
): LiveWalletSignal | undefined {
  const sorted = trades
    .filter((trade) => trade.conditionId === market.conditionId && sameWallet(trade.proxyWallet, wallet))
    .sort((a, b) => a.timestamp - b.timestamp);
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
  const limitPrice = entryLimitPrice(input.observedPrice, input.config.maxSlippageCents, input.market.minTickSize);
  const size = input.config.defaultEntrySpendUsdc / limitPrice;

  return ticket({
    ...input,
    kind: "entry",
    limitPrice,
    size,
    spendUsdc: input.config.defaultEntrySpendUsdc,
    reason: "Confirmed entry ticket from strict live candidate"
  });
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
  const limitPrice = exitLimitPrice(input.observedPrice, input.config.maxSlippageCents, input.market.minTickSize);
  const size = Math.min(input.requestedShares, input.availableShares);

  return ticket({
    ...input,
    kind: "exit",
    limitPrice,
    size,
    availableShares: input.availableShares,
    reason: "Confirmed exit ticket from candidate sell signal"
  });
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

function sameWallet(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
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

function entryLimitPrice(observedPrice: number, maxSlippageCents: number, tick: number): number {
  const rounded = roundToTick(observedPrice + maxSlippageCents / 100, tick);
  return rounded > 0.99 ? floorToTick(0.99, tick) : rounded;
}

function exitLimitPrice(observedPrice: number, maxSlippageCents: number, tick: number): number {
  const rounded = roundToTick(observedPrice - maxSlippageCents / 100, tick);
  return rounded < 0.01 ? ceilToTick(0.01, tick) : rounded;
}

function roundToTick(value: number, tick: number): number {
  return round(Math.round(value / tick) * tick);
}

function floorToTick(value: number, tick: number): number {
  return round(Math.floor(value / tick) * tick);
}

function ceilToTick(value: number, tick: number): number {
  return round(Math.ceil(value / tick) * tick);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
