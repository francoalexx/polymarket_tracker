import { isBtcShortTermTrade } from "./copyTrader";
import type { ActivityTrade, LeaderboardTrader, MarketType } from "./types";

export type { LeaderboardTrader } from "./types";

export type CandidateOptions = {
  earlyEntrySeconds?: number;
  holdSellRatioThreshold?: number;
  marketTypes?: MarketType[];
};

export type CandidateMarketSummary = {
  conditionId: string;
  slug: string;
  title: string;
  trades: number;
  firstTradeTimestamp: number;
  firstEntrySeconds: number;
  winner: string;
  netSharesByOutcome: Record<string, number>;
  buyCost: number;
  sellProceeds: number;
  settlementValue: number;
  pnl: number;
  isWin: boolean;
  isLoss: boolean;
  isEarlyEntry: boolean;
  isOneSided: boolean;
  isHoldThrough: boolean;
};

export type CandidateSummary = {
  proxyWallet: string;
  userName?: string;
  rank: string;
  leaderboardPnl: number;
  leaderboardVol: number;
  totalMarkets: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  totalPnl: number;
  totalBuy: number;
  totalSell: number;
  settlementValue: number;
  roi: number;
  earlyEntryRate: number;
  oneSidedRate: number;
  holdThroughRate: number;
  averageFirstEntrySeconds: number;
  copyabilityScore: number;
  markets: CandidateMarketSummary[];
};

const EPSILON = 1e-6;

export function isBtcFiveMinuteTrade(trade: Pick<ActivityTrade, "title" | "slug">): boolean {
  return isBtcShortTermTrade(trade, "5m");
}

export function isBtcFifteenMinuteTrade(trade: Pick<ActivityTrade, "title" | "slug">): boolean {
  return isBtcShortTermTrade(trade, "15m");
}

export function isBtcShortTermHistoryTrade(trade: Pick<ActivityTrade, "title" | "slug">): boolean {
  return isBtcShortTermTrade(trade);
}

export function analyzeCandidate(
  trader: LeaderboardTrader,
  activity: ActivityTrade[],
  winnerByCondition: Map<string, string>,
  options: CandidateOptions = {}
): CandidateSummary {
  const earlyEntrySeconds = options.earlyEntrySeconds ?? 90;
  const holdSellRatioThreshold = options.holdSellRatioThreshold ?? 0.1;
  const marketTypes = options.marketTypes ?? ["5m"];
  const grouped = new Map<string, ActivityTrade[]>();

  for (const trade of activity.filter((item) => marketTypes.some((marketType) => isBtcShortTermTrade(item, marketType)))) {
    const trades = grouped.get(trade.conditionId) ?? [];
    trades.push(trade);
    grouped.set(trade.conditionId, trades);
  }

  const markets = Array.from(grouped.values())
    .map((trades) => summarizeMarket(trades, winnerByCondition.get(trades[0].conditionId), earlyEntrySeconds, holdSellRatioThreshold))
    .filter((market): market is CandidateMarketSummary => market !== undefined)
    .sort((a, b) => a.firstTradeTimestamp - b.firstTradeTimestamp);

  const totalMarkets = markets.length;
  const wins = markets.filter((market) => market.isWin).length;
  const losses = markets.filter((market) => market.isLoss).length;
  const totalPnl = sum(markets, "pnl");
  const totalBuy = sum(markets, "buyCost");
  const totalSell = sum(markets, "sellProceeds");
  const settlementValue = sum(markets, "settlementValue");
  const earlyEntryRate = rate(markets.filter((market) => market.isEarlyEntry).length, totalMarkets);
  const oneSidedRate = rate(markets.filter((market) => market.isOneSided).length, totalMarkets);
  const holdThroughRate = rate(markets.filter((market) => market.isHoldThrough).length, totalMarkets);
  const winRate = rate(wins, totalMarkets);

  return {
    proxyWallet: trader.proxyWallet,
    userName: trader.userName,
    rank: trader.rank,
    leaderboardPnl: Number(trader.pnl || 0),
    leaderboardVol: Number(trader.vol || 0),
    totalMarkets,
    totalTrades: markets.reduce((total, market) => total + market.trades, 0),
    wins,
    losses,
    breakeven: totalMarkets - wins - losses,
    winRate,
    totalPnl,
    totalBuy,
    totalSell,
    settlementValue,
    roi: totalBuy > 0 ? totalPnl / totalBuy : 0,
    earlyEntryRate,
    oneSidedRate,
    holdThroughRate,
    averageFirstEntrySeconds: totalMarkets ? round(markets.reduce((total, market) => total + market.firstEntrySeconds, 0) / totalMarkets) : 0,
    copyabilityScore: scoreCandidate({ winRate, earlyEntryRate, oneSidedRate, holdThroughRate, roi: totalBuy > 0 ? totalPnl / totalBuy : 0, totalMarkets }),
    markets
  };
}

function summarizeMarket(
  trades: ActivityTrade[],
  winner: string | undefined,
  earlyEntrySeconds: number,
  holdSellRatioThreshold: number
): CandidateMarketSummary | undefined {
  if (!winner) return undefined;

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const [first] = sorted;
  const marketStart = getMarketStartTimestamp(first.slug) ?? first.timestamp;
  const netSharesByOutcome: Record<string, number> = {};
  const buyOutcomes = new Set<string>();
  let buyCost = 0;
  let sellProceeds = 0;

  for (const trade of sorted) {
    const size = Number(trade.size || 0);
    const usdcSize = Number(trade.usdcSize || 0);

    if (trade.side === "BUY") {
      buyCost += usdcSize;
      buyOutcomes.add(trade.outcome);
      netSharesByOutcome[trade.outcome] = (netSharesByOutcome[trade.outcome] ?? 0) + size;
    } else if (trade.side === "SELL") {
      sellProceeds += usdcSize;
      netSharesByOutcome[trade.outcome] = (netSharesByOutcome[trade.outcome] ?? 0) - size;
    }
  }

  const firstEntrySeconds = Math.max(0, first.timestamp - marketStart);
  const settlementValue = Math.max(0, netSharesByOutcome[winner] ?? 0);
  const pnl = sellProceeds - buyCost + settlementValue;
  const nonZeroOutcomes = Object.values(netSharesByOutcome).filter((shares) => Math.abs(shares) > EPSILON).length;

  return {
    conditionId: first.conditionId,
    slug: first.slug,
    title: first.title,
    trades: sorted.length,
    firstTradeTimestamp: first.timestamp,
    firstEntrySeconds,
    winner,
    netSharesByOutcome: roundRecord(netSharesByOutcome),
    buyCost: round(buyCost),
    sellProceeds: round(sellProceeds),
    settlementValue: round(settlementValue),
    pnl: round(pnl),
    isWin: pnl > EPSILON,
    isLoss: pnl < -EPSILON,
    isEarlyEntry: firstEntrySeconds <= earlyEntrySeconds,
    isOneSided: buyOutcomes.size <= 1 && nonZeroOutcomes <= 1,
    isHoldThrough: buyCost === 0 ? sellProceeds === 0 : sellProceeds / buyCost <= holdSellRatioThreshold
  };
}

function getMarketStartTimestamp(slug: string): number | undefined {
  const match = slug.match(/-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function scoreCandidate(metrics: {
  winRate: number;
  earlyEntryRate: number;
  oneSidedRate: number;
  holdThroughRate: number;
  roi: number;
  totalMarkets: number;
}): number {
  const roiScore = clamp((metrics.roi + 0.25) / 1.0, 0, 1);
  const score =
    metrics.winRate * 30 +
    metrics.earlyEntryRate * 25 +
    metrics.oneSidedRate * 20 +
    metrics.holdThroughRate * 15 +
    roiScore * 10;

  return round(score);
}

function rate(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

function sum<T extends Record<string, unknown>>(items: T[], key: keyof T): number {
  return round(items.reduce((total, item) => total + Number(item[key] || 0), 0));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function roundRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, round(value)]));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
