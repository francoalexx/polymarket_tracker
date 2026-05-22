import { analyzeCandidate } from "../shared/candidateScanner";
import {
  DEFAULT_COPY_TRADER_CONFIG,
  buildEntryTicket,
  getLatencyMode,
  passesStrictHistory,
  summarizeLiveWallet
} from "../shared/copyTrader";
import type { CandidateSummary } from "../shared/candidateScanner";
import type {
  ActivityTrade,
  CandidateFeedItem,
  CopyTraderConfig,
  ExecutionLogEntry,
  GammaMarket,
  LatencySample,
  MarketMetadata,
  PreparedTradeTicket,
  SignalCooldownKey,
  ScannerSnapshot
} from "../shared/types";
import { PolymarketClient } from "./polymarketClient";

type ScannerClient = Pick<
  PolymarketClient,
  "getShortTermBtcMarkets" | "getTradesByMarkets" | "getLeaderboardTraders" | "getActivityRange" | "getGammaMarketBySlug"
>;
type ScannerSubscriber = (snapshot: ScannerSnapshot) => void;
type SummarizeHistory = (wallet: string, signalTrades: ActivityTrade[]) => Promise<CandidateSummary>;

type ScannerServiceOptions = {
  client?: ScannerClient;
  config?: CopyTraderConfig;
  intervalMs?: number;
  now?: () => number;
  summarizeHistory?: SummarizeHistory;
};

const MAX_LATENCY_SAMPLES = 100;
const MAX_CANDIDATES = 50;
const MAX_TICKETS = 50;
const MAX_EXECUTIONS = 100;
const HISTORY_CACHE_SECONDS = 5 * 60;
const WINNER_LOOKUP_CONCURRENCY = 4;

export class ScannerService {
  private readonly client: ScannerClient;
  private readonly config: CopyTraderConfig;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly summarizeHistoryOverride?: SummarizeHistory;
  private readonly subscribers = new Set<ScannerSubscriber>();
  private readonly latencySamples: LatencySample[] = [];
  private readonly cooldowns = new Map<string, number>();
  private readonly historySummaryCache = new Map<string, { expiresAt: number; summary: Promise<CandidateSummary> }>();
  private readonly winnerCache = new Map<string, Promise<string | undefined>>();
  private snapshot: ScannerSnapshot;
  private timer?: NodeJS.Timeout;
  private inFlightScan?: Promise<void>;

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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  subscribe(subscriber: ScannerSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.snapshot);
    return () => this.subscribers.delete(subscriber);
  }

  getSnapshot(): ScannerSnapshot {
    return this.snapshot;
  }

  cancelTicket(id: string): PreparedTradeTicket | undefined {
    const ticket = this.snapshot.tickets.find((candidate) => candidate.id === id);
    if (!ticket) return undefined;

    ticket.status = "cancelled";
    this.publish("live", "Ticket cancelled");
    return ticket;
  }

  recordExecution(entry: ExecutionLogEntry): void {
    this.snapshot = {
      ...this.snapshot,
      executions: [entry, ...this.snapshot.executions].slice(0, MAX_EXECUTIONS)
    };
    this.publish("live", "Execution recorded");
  }

  markTicketSubmitted(id: string): void {
    const ticket = this.snapshot.tickets.find((candidate) => candidate.id === id);
    if (!ticket) return;

    ticket.status = "submitted";
    this.publish("live", "Ticket submitted");
  }

  async scanOnce(): Promise<void> {
    if (this.inFlightScan) return this.inFlightScan;

    this.inFlightScan = this.runScanOnce();
    try {
      await this.inFlightScan;
    } finally {
      this.inFlightScan = undefined;
    }
  }

  private async runScanOnce(): Promise<void> {
    try {
      const latency = getLatencyMode(this.latencySamples.slice(-20), this.config);
      const markets = await this.client.getShortTermBtcMarkets({
        marketType: latency.activeMarketType,
        now: this.now(),
        lookbackMarkets: latency.activeMarketType === "5m" ? 8 : 4
      });
      const trades = await this.client.getTradesByMarkets(markets.map((market) => market.conditionId));
      const candidates = await this.promoteCandidates(markets, trades);

      this.snapshot = {
        ...this.snapshot,
        status: "live",
        message: latency.isDegraded ? "BTC 5m latency degraded; scanning BTC 15m" : `Scanning BTC ${latency.activeMarketType}`,
        receivedAt: Date.now(),
        latency,
        candidates
      };
      this.notify();
    } catch (error) {
      this.publish("error", error instanceof Error ? error.message : String(error));
    }
  }

  private async promoteCandidates(markets: MarketMetadata[], trades: ActivityTrade[]): Promise<CandidateFeedItem[]> {
    const now = this.now();
    const marketByCondition = new Map(markets.map((market) => [market.conditionId, market]));
    const tradesByWalletAndMarket = new Map<string, Map<string, ActivityTrade[]>>();

    for (const trade of trades) {
      const market = marketByCondition.get(trade.conditionId);
      if (!market) continue;

      this.addLatencySample({
        source: "market_trades",
        marketType: market.marketType,
        latencySeconds: Math.max(0, now - trade.timestamp),
        tradeTimestamp: trade.timestamp,
        receivedAt: now
      });

      const wallet = trade.proxyWallet.trim().toLowerCase();
      const walletTrades = tradesByWalletAndMarket.get(wallet) ?? new Map<string, ActivityTrade[]>();
      const marketTrades = walletTrades.get(trade.conditionId) ?? [];
      marketTrades.push(trade);
      walletTrades.set(trade.conditionId, marketTrades);
      tradesByWalletAndMarket.set(wallet, walletTrades);
    }

    const candidates: CandidateFeedItem[] = [];

    for (const [wallet, tradesByMarket] of tradesByWalletAndMarket) {
      for (const [conditionId, walletTrades] of tradesByMarket) {
        const market = marketByCondition.get(conditionId);
        if (!market) continue;

        const signal = summarizeLiveWallet(wallet, walletTrades, market, now, this.config);
        if (!signal) continue;

        const isActionable = signal.recommendation === "prepare_entry" || signal.recommendation === "prepare_exit";
        const kind = signal.recommendation === "prepare_exit" ? "exit" : "entry";
        const cooldownKey: SignalCooldownKey = { wallet, conditionId, kind };
        if (isActionable && this.isCoolingDown(cooldownKey, now)) continue;

        const history = await this.summarizeHistory(wallet, walletTrades);
        const strictPass = passesStrictHistory(history);
        if (!strictPass) continue;

        if (isActionable) {
          this.markCooldown(cooldownKey, now);
        }

        candidates.push({
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
          this.addTicket(
            buildEntryTicket({
              wallet,
              market,
              outcome: signal.outcome,
              asset: signal.asset,
              observedPrice: signal.observedPrice,
              candidateTradeId: signal.candidateTradeId,
              now,
              config: this.config
            })
          );
        }
      }
    }

    return candidates.sort((left, right) => right.score - left.score || left.latencySeconds - right.latencySeconds).slice(0, MAX_CANDIDATES);
  }

  private async summarizeHistory(wallet: string, signalTrades: ActivityTrade[]): Promise<CandidateSummary> {
    if (this.summarizeHistoryOverride) return this.summarizeHistoryOverride(wallet, signalTrades);

    const end = this.now();
    const cacheKey = wallet.trim().toLowerCase();
    const cached = this.historySummaryCache.get(cacheKey);
    if (cached && cached.expiresAt > end) return cached.summary;

    const summary = this.buildHistorySummary(wallet, end);
    this.historySummaryCache.set(cacheKey, { expiresAt: end + HISTORY_CACHE_SECONDS, summary });
    summary.catch(() => this.historySummaryCache.delete(cacheKey));
    return summary;
  }

  private async buildHistorySummary(wallet: string, end: number): Promise<CandidateSummary> {
    const start = end - 7 * 24 * 60 * 60;
    const activity = await this.client.getActivityRange(wallet, start, end);
    const winnerByCondition = await this.loadWinners(activity);

    return analyzeCandidate({ proxyWallet: wallet, rank: "", pnl: 0, vol: 0 }, activity, winnerByCondition, {
      marketTypes: ["5m", "15m"],
      earlyEntrySeconds: this.config.earlyEntrySeconds
    });
  }

  private async loadWinners(activity: ActivityTrade[]): Promise<Map<string, string>> {
    const tradeByCondition = new Map<string, ActivityTrade>();
    for (const trade of activity) {
      if (!tradeByCondition.has(trade.conditionId)) tradeByCondition.set(trade.conditionId, trade);
    }

    const winnerByCondition = new Map<string, string>();
    await mapWithConcurrency(Array.from(tradeByCondition.values()), WINNER_LOOKUP_CONCURRENCY, async (trade) => {
      const winner = await this.getCachedWinner(trade);
      if (winner) winnerByCondition.set(trade.conditionId, winner);
    });

    return winnerByCondition;
  }

  private getCachedWinner(trade: ActivityTrade): Promise<string | undefined> {
    const cached = this.winnerCache.get(trade.conditionId);
    if (cached) return cached;

    const winner = this.client
      .getGammaMarketBySlug(trade.slug)
      .then((gammaMarket) => (gammaMarket ? getWinningOutcome(gammaMarket) : undefined))
      .catch((error) => {
        this.winnerCache.delete(trade.conditionId);
        throw error;
      });
    this.winnerCache.set(trade.conditionId, winner);
    return winner;
  }

  private isCoolingDown(key: SignalCooldownKey, now: number): boolean {
    const previous = this.cooldowns.get(cooldownKey(key));
    return previous !== undefined && now - previous < this.config.repeatCooldownSeconds;
  }

  private markCooldown(key: SignalCooldownKey, now: number): void {
    this.cooldowns.set(cooldownKey(key), now);
  }

  private addLatencySample(sample: LatencySample): void {
    this.latencySamples.push(sample);
    if (this.latencySamples.length > MAX_LATENCY_SAMPLES) {
      this.latencySamples.splice(0, this.latencySamples.length - MAX_LATENCY_SAMPLES);
    }
  }

  private addTicket(ticket: PreparedTradeTicket): void {
    if (this.snapshot.tickets.some((candidate) => candidate.id === ticket.id)) return;
    this.snapshot = {
      ...this.snapshot,
      tickets: [ticket, ...this.snapshot.tickets].slice(0, MAX_TICKETS)
    };
  }

  private publish(status: ScannerSnapshot["status"], message: string): void {
    this.snapshot = {
      ...this.snapshot,
      status,
      message,
      receivedAt: Date.now()
    };
    this.notify();
  }

  private notify(): void {
    for (const subscriber of this.subscribers) {
      subscriber(this.snapshot);
    }
  }
}

function getWinningOutcome(market: Pick<GammaMarket, "closed" | "outcomes" | "outcomePrices">): string | undefined {
  if (!market.closed) return undefined;

  const outcomes = readJsonArray(market.outcomes).map(String);
  const prices = readJsonArray(market.outcomePrices).map((price) => Number(price));
  if (outcomes.length === 0 || outcomes.length !== prices.length) return undefined;

  const maxPrice = Math.max(...prices);
  if (!Number.isFinite(maxPrice) || maxPrice < 0.99) return undefined;

  const winningIndex = prices.findIndex((price) => price === maxPrice);
  return outcomes[winningIndex];
}

function readJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cooldownKey(key: SignalCooldownKey): string {
  return `${key.kind}:${key.wallet}:${key.conditionId}`;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    })
  );
}
