import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeCandidate, isBtcFiveMinuteTrade, type CandidateSummary } from "../shared/candidateScanner";
import type { ActivityTrade, GammaMarket } from "../shared/types";
import { PolymarketClient } from "../server/polymarketClient";

type ScannerConfig = {
  limit: number;
  days: number;
  minMarkets: number;
  minScore: number;
  earlyEntrySeconds: number;
  concurrency: number;
  outputDir: string;
};

const DEFAULT_CONFIG: ScannerConfig = {
  limit: 250,
  days: 7,
  minMarkets: 30,
  minScore: 0,
  earlyEntrySeconds: 90,
  concurrency: 3,
  outputDir: "reports"
};

const client = new PolymarketClient();
const marketCache = new Map<string, Promise<GammaMarket | undefined>>();

async function main(): Promise<void> {
  const config = readConfig(process.argv.slice(2));
  const end = Math.floor(Date.now() / 1000);
  const start = end - config.days * 24 * 60 * 60;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  console.log(`Scanning top ${config.limit} weekly CRYPTO leaderboard wallets...`);
  const leaderboard = await client.getLeaderboardTraders({
    category: "CRYPTO",
    timePeriod: "WEEK",
    orderBy: "PNL",
    limit: config.limit
  });

  const summaries = await mapConcurrent(leaderboard, config.concurrency, async (trader, index) => {
    console.log(`[${index + 1}/${leaderboard.length}] ${trader.userName ?? trader.proxyWallet}`);
    const activity = await client.getActivityRange(trader.proxyWallet, start, end);
    const btc5 = activity.filter(isBtcFiveMinuteTrade);
    const winners = await getWinnersByCondition(btc5);
    return analyzeCandidate(trader, btc5, winners, { earlyEntrySeconds: config.earlyEntrySeconds });
  });

  const ranked = summaries
    .filter((summary) => summary.totalMarkets > 0)
    .sort((a, b) => b.copyabilityScore - a.copyabilityScore || b.totalPnl - a.totalPnl);
  const candidates = ranked.filter((summary) => summary.totalMarkets >= config.minMarkets && summary.copyabilityScore >= config.minScore);

  await mkdir(config.outputDir, { recursive: true });
  const jsonPath = join(config.outputDir, `candidate-scan-${stamp}.json`);
  const markdownPath = join(config.outputDir, `candidate-scan-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify({ config, start, end, scanned: leaderboard.length, candidates, ranked }, null, 2));
  await writeFile(markdownPath, renderMarkdown({ config, start, end, scanned: leaderboard.length, candidates, ranked }));

  console.log("");
  console.log(`Scanned ${leaderboard.length} wallets; ${candidates.length} met the minimum market/score filters.`);
  console.log(`Markdown: ${markdownPath}`);
  console.log(`JSON: ${jsonPath}`);
  console.log("");
  console.log(renderConsoleTop(candidates.slice(0, 10)));
}

async function getWinnersByCondition(activity: ActivityTrade[]): Promise<Map<string, string>> {
  const byCondition = new Map<string, ActivityTrade>();
  for (const trade of activity) {
    if (!byCondition.has(trade.conditionId)) byCondition.set(trade.conditionId, trade);
  }

  const winners = new Map<string, string>();
  await Promise.all(
    Array.from(byCondition.values()).map(async (trade) => {
      const market = await getMarket(trade.slug);
      const winner = market ? getWinningOutcome(market) : undefined;
      if (winner) winners.set(trade.conditionId, winner);
    })
  );

  return winners;
}

function getMarket(slug: string): Promise<GammaMarket | undefined> {
  const existing = marketCache.get(slug);
  if (existing) return existing;

  const promise = client.getGammaMarketBySlug(slug);
  marketCache.set(slug, promise);
  return promise;
}

function getWinningOutcome(market: GammaMarket): string | undefined {
  if (!market.closed) return undefined;

  const outcomes = readJsonArray(market.outcomes);
  const prices = readJsonArray(market.outcomePrices).map((price) => Number(price));
  if (outcomes.length === 0 || outcomes.length !== prices.length) return undefined;

  const winningIndex = prices.findIndex((price) => price === Math.max(...prices));
  return prices[winningIndex] >= 0.99 ? String(outcomes[winningIndex]) : undefined;
}

function readJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

function readConfig(args: string[]): ScannerConfig {
  const config = { ...DEFAULT_CONFIG };

  for (const arg of args) {
    const [key, rawValue] = arg.split("=");
    const value = rawValue ?? "";
    if (key === "--limit") config.limit = readPositiveInteger(value, config.limit);
    if (key === "--days") config.days = readPositiveInteger(value, config.days);
    if (key === "--min-markets") config.minMarkets = readPositiveInteger(value, config.minMarkets);
    if (key === "--min-score") config.minScore = readNumber(value, config.minScore);
    if (key === "--early-seconds") config.earlyEntrySeconds = readPositiveInteger(value, config.earlyEntrySeconds);
    if (key === "--concurrency") config.concurrency = readPositiveInteger(value, config.concurrency);
    if (key === "--out") config.outputDir = value || config.outputDir;
  }

  config.limit = Math.min(250, config.limit);
  config.concurrency = Math.min(8, config.concurrency);
  return config;
}

function readPositiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function renderMarkdown(input: {
  config: ScannerConfig;
  start: number;
  end: number;
  scanned: number;
  candidates: CandidateSummary[];
  ranked: CandidateSummary[];
}): string {
  const lines = [
    "# Polymarket BTC 5-Minute Copy Candidate Scan",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Activity window: ${new Date(input.start * 1000).toISOString()} through ${new Date(input.end * 1000).toISOString()}`,
    `Leaderboard: top ${input.config.limit} weekly CRYPTO wallets by PnL`,
    "",
    "## Filters",
    "",
    `- Minimum BTC 5-minute markets: ${input.config.minMarkets}`,
    `- Early entry threshold: ${input.config.earlyEntrySeconds} seconds`,
    `- Minimum copyability score: ${input.config.minScore}`,
    "",
    "## Best Candidates",
    "",
    renderCandidateTable(input.candidates.slice(0, 50)),
    "",
    "## All Wallets With BTC 5-Minute Activity",
    "",
    renderCandidateTable(input.ranked)
  ];

  return `${lines.join("\n")}\n`;
}

function renderCandidateTable(candidates: CandidateSummary[]): string {
  if (candidates.length === 0) return "_No wallets matched this section._";

  const rows = [
    "| # | Wallet | User | Markets | Win % | PnL | ROI % | Early % | One-sided % | Hold % | Score |",
    "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];

  candidates.forEach((candidate, index) => {
    rows.push(
      [
        index + 1,
        `\`${candidate.proxyWallet}\``,
        candidate.userName ?? "",
        candidate.totalMarkets,
        percent(candidate.winRate),
        money(candidate.totalPnl),
        percent(candidate.roi),
        percent(candidate.earlyEntryRate),
        percent(candidate.oneSidedRate),
        percent(candidate.holdThroughRate),
        candidate.copyabilityScore.toFixed(1)
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    );
  });

  return rows.join("\n");
}

function renderConsoleTop(candidates: CandidateSummary[]): string {
  if (candidates.length === 0) return "No candidates matched the current filters.";

  return candidates
    .map(
      (candidate, index) =>
        `${index + 1}. ${candidate.userName ?? shortWallet(candidate.proxyWallet)} ${candidate.proxyWallet} ` +
        `score=${candidate.copyabilityScore.toFixed(1)} markets=${candidate.totalMarkets} win=${percent(candidate.winRate)} pnl=${money(candidate.totalPnl)}`
    )
    .join("\n");
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function money(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
