import { analyzeCandidate, isBtcFiveMinuteTrade } from "../shared/candidateScanner";
import type { ActivityTrade, GammaEvent, GammaMarket, LeaderboardTrader } from "../shared/types";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const MARKET_SECONDS = 5 * 60;
const RECENT_SECONDS = 30 * 60;
const HISTORY_DAYS = 2;
const HISTORY_PAGES = 3;
const HISTORY_PAGE_SIZE = 500;
const EARLY_SECONDS = 120;
const MIN_HISTORY_MARKETS = 5;
const EXCLUDED_WALLETS = new Set(["0xe91016e83d11a0306c12ed390c79e89406eea40a"]);

type RecentMarket = {
  slug: string;
  start: number;
  conditionId: string;
  title: string;
};

type LiveCandidate = {
  wallet: string;
  name?: string;
  recentMarkets: number;
  recentTrades: number;
  recentBuyCost: number;
  recentOutcomes: string[];
  earliestEntrySeconds: number;
  latestTradeTimestamp: number;
};

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const markets = await getRecentMarkets(now);
  const trades = await getRecentTrades(markets, now - RECENT_SECONDS);
  const liveCandidates = getLiveCandidates(trades, markets);

  console.log(`Recent BTC 5m markets: ${markets.length}`);
  console.log(`Recent BTC 5m trades: ${trades.length}`);
  console.log(`Live early one-sided wallets: ${liveCandidates.length}`);
  if (liveCandidates.length === 0) {
    console.log(renderLiveDiagnostics(trades, markets));
  }

  const ranked = [];
  const historyStart = now - HISTORY_DAYS * 24 * 60 * 60;
  const winners = new Map<string, string>();

  for (const [index, live] of liveCandidates.slice(0, 25).entries()) {
    console.log(`[history ${index + 1}/${Math.min(liveCandidates.length, 25)}] ${live.name ?? live.wallet}`);
    const activity = await getWalletRecentActivity(live.wallet, historyStart);
    const btc5 = activity.filter(isBtcFiveMinuteTrade);
    await loadWinners(btc5, winners);

    const trader: LeaderboardTrader = {
      proxyWallet: live.wallet,
      userName: live.name,
      rank: "",
      pnl: 0,
      vol: 0
    };
    const summary = analyzeCandidate(trader, btc5, winners, { earlyEntrySeconds: EARLY_SECONDS });

    if (summary.totalMarkets < MIN_HISTORY_MARKETS) continue;
    if (summary.totalPnl <= 0) continue;
    if (summary.winRate < 0.55) continue;
    if (summary.oneSidedRate < 0.8) continue;

    ranked.push({ live, summary });
  }

  ranked.sort(
    (a, b) =>
      b.summary.totalPnl - a.summary.totalPnl ||
      b.summary.winRate - a.summary.winRate ||
      b.summary.copyabilityScore - a.summary.copyabilityScore
  );

  console.log("");
  console.log(renderResults(ranked.slice(0, 10), now));
}

async function getRecentMarkets(now: number): Promise<RecentMarket[]> {
  const currentStart = Math.floor(now / MARKET_SECONDS) * MARKET_SECONDS;
  const starts = Array.from({ length: 9 }, (_, index) => currentStart - index * MARKET_SECONDS);
  const markets = await Promise.all(starts.map((start) => getMarketBySlug(`btc-updown-5m-${start}`, start)));
  return markets.filter((market): market is RecentMarket => Boolean(market));
}

async function getMarketBySlug(slug: string, start: number): Promise<RecentMarket | undefined> {
  const url = new URL("/events", GAMMA_API);
  url.searchParams.set("slug", slug);
  const [event] = await fetchList<GammaEvent>(url);
  const market = event?.markets?.find((candidate) => candidate.slug === slug);
  if (!market?.conditionId) return undefined;
  return { slug, start, conditionId: market.conditionId, title: market.question };
}

async function getRecentTrades(markets: RecentMarket[], minTimestamp: number): Promise<ActivityTrade[]> {
  if (markets.length === 0) return [];
  const url = new URL("/trades", DATA_API);
  url.searchParams.set("market", markets.map((market) => market.conditionId).join(","));
  url.searchParams.set("limit", "10000");
  url.searchParams.set("takerOnly", "false");

  const rows = await fetchList<ActivityTrade>(url);
  const marketIds = new Set(markets.map((market) => market.conditionId));
  return rows.filter((trade) => marketIds.has(trade.conditionId) && trade.timestamp >= minTimestamp);
}

async function getWalletRecentActivity(wallet: string, minTimestamp: number): Promise<ActivityTrade[]> {
  const rows: ActivityTrade[] = [];

  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const url = new URL("/activity", DATA_API);
    url.searchParams.set("user", wallet);
    url.searchParams.set("limit", String(HISTORY_PAGE_SIZE));
    url.searchParams.set("offset", String(page * HISTORY_PAGE_SIZE));
    url.searchParams.set("type", "TRADE");
    url.searchParams.set("sortDirection", "DESC");

    const pageRows = await fetchList<ActivityTrade>(url);
    rows.push(...pageRows);
    if (pageRows.length < HISTORY_PAGE_SIZE) break;
    if (pageRows.some((trade) => trade.timestamp < minTimestamp)) break;
  }

  const deduped = new Map<string, ActivityTrade>();
  for (const trade of rows.filter((trade) => trade.timestamp >= minTimestamp)) {
    deduped.set(
      [trade.transactionHash, trade.asset, trade.side, Number(trade.price).toFixed(8), Number(trade.size).toFixed(8), trade.timestamp].join(":"),
      trade
    );
  }

  return Array.from(deduped.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function getLiveCandidates(trades: ActivityTrade[], markets: RecentMarket[]): LiveCandidate[] {
  const startByCondition = new Map(markets.map((market) => [market.conditionId, market.start]));
  const grouped = new Map<string, ActivityTrade[]>();

  for (const trade of trades) {
    const group = grouped.get(trade.proxyWallet) ?? [];
    group.push(trade);
    grouped.set(trade.proxyWallet, group);
  }

  return Array.from(grouped.entries())
    .map(([wallet, walletTrades]) => summarizeLiveWallet(wallet, walletTrades, startByCondition))
    .filter((candidate): candidate is LiveCandidate => Boolean(candidate))
    .filter((candidate) => !EXCLUDED_WALLETS.has(candidate.wallet.toLowerCase()))
    .sort((a, b) => b.recentBuyCost - a.recentBuyCost || a.earliestEntrySeconds - b.earliestEntrySeconds);
}

function renderLiveDiagnostics(trades: ActivityTrade[], markets: RecentMarket[]): string {
  const startByCondition = new Map(markets.map((market) => [market.conditionId, market.start]));
  const byWallet = new Map<string, ActivityTrade[]>();
  for (const trade of trades) {
    const group = byWallet.get(trade.proxyWallet) ?? [];
    group.push(trade);
    byWallet.set(trade.proxyWallet, group);
  }

  const rows = Array.from(byWallet.entries())
    .map(([wallet, walletTrades]) => {
      const sorted = [...walletTrades].sort((a, b) => a.timestamp - b.timestamp);
      const first = sorted[0];
      const start = startByCondition.get(first.conditionId) ?? first.timestamp;
      const outcomes = new Set(sorted.map((trade) => trade.outcome));
      return {
        wallet,
        name: sorted.find((trade) => trade.name)?.name,
        trades: sorted.length,
        entrySeconds: first.timestamp - start,
        outcomes: Array.from(outcomes).sort().join("/"),
        latest: Math.max(...sorted.map((trade) => trade.timestamp))
      };
    })
    .sort((a, b) => a.entrySeconds - b.entrySeconds || b.trades - a.trades)
    .slice(0, 10);

  return [
    "",
    "Closest live wallets before historical filters:",
    ...rows.map(
      (row, index) =>
        `${index + 1}. ${row.name ?? row.wallet} ${row.wallet} entry=${row.entrySeconds}s trades=${row.trades} outcomes=${row.outcomes} latest=${new Date(row.latest * 1000).toISOString()}`
    )
  ].join("\n");
}

function summarizeLiveWallet(
  wallet: string,
  trades: ActivityTrade[],
  startByCondition: Map<string, number>
): LiveCandidate | undefined {
  const byMarket = new Map<string, ActivityTrade[]>();
  for (const trade of trades) {
    const group = byMarket.get(trade.conditionId) ?? [];
    group.push(trade);
    byMarket.set(trade.conditionId, group);
  }

  const earlyOneSidedMarkets = Array.from(byMarket.values()).filter((marketTrades) => {
    const sorted = [...marketTrades].sort((a, b) => a.timestamp - b.timestamp);
    const first = sorted[0];
    const start = startByCondition.get(first.conditionId) ?? first.timestamp;
    const buyOutcomes = new Set<string>();
    const netSharesByOutcome = new Map<string, number>();

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

    const nonZeroOutcomes = Array.from(netSharesByOutcome.values()).filter((shares) => Math.abs(shares) > 1e-6).length;
    return first.timestamp - start <= EARLY_SECONDS && buyOutcomes.size <= 1 && nonZeroOutcomes <= 1;
  });

  if (earlyOneSidedMarkets.length === 0) return undefined;

  const selectedTrades = earlyOneSidedMarkets.flat();
  const firstEntries = earlyOneSidedMarkets.map((marketTrades) => {
    const first = [...marketTrades].sort((a, b) => a.timestamp - b.timestamp)[0];
    return first.timestamp - (startByCondition.get(first.conditionId) ?? first.timestamp);
  });
  const buyCost = selectedTrades
    .filter((trade) => trade.side === "BUY")
    .reduce((total, trade) => total + Number(trade.usdcSize || trade.size * trade.price || 0), 0);

  return {
    wallet,
    name: selectedTrades.find((trade) => trade.name)?.name,
    recentMarkets: earlyOneSidedMarkets.length,
    recentTrades: selectedTrades.length,
    recentBuyCost: round(buyCost),
    recentOutcomes: Array.from(new Set(selectedTrades.map((trade) => trade.outcome))).sort(),
    earliestEntrySeconds: Math.min(...firstEntries),
    latestTradeTimestamp: Math.max(...selectedTrades.map((trade) => trade.timestamp))
  };
}

async function loadWinners(activity: ActivityTrade[], winners: Map<string, string>): Promise<void> {
  const missing = Array.from(new Map(activity.map((trade) => [trade.conditionId, trade])).values()).filter(
    (trade) => !winners.has(trade.conditionId)
  );

  await mapConcurrent(missing, 8, async (trade) => {
    const market = await getGammaMarketBySlug(trade.slug);
    const winner = market ? getWinningOutcome(market) : undefined;
    if (winner) winners.set(trade.conditionId, winner);
  });
}

async function getGammaMarketBySlug(slug: string): Promise<GammaMarket | undefined> {
  const url = new URL("/events", GAMMA_API);
  url.searchParams.set("slug", slug);
  const [event] = await fetchList<GammaEvent>(url);
  return event?.markets?.find((market) => market.slug === slug);
}

function getWinningOutcome(market: GammaMarket): string | undefined {
  if (!market.closed) return undefined;
  const outcomes = readJsonArray(market.outcomes);
  const prices = readJsonArray(market.outcomePrices).map((price) => Number(price));
  if (outcomes.length === 0 || outcomes.length !== prices.length) return undefined;

  const winningIndex = prices.findIndex((price) => price === Math.max(...prices));
  return prices[winningIndex] >= 0.99 ? String(outcomes[winningIndex]) : undefined;
}

async function fetchList<T>(url: URL): Promise<T[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json",
          "user-agent": "codex-polymarket-live-btc5/0.1"
        }
      });

      if (!response.ok) {
        throw new Error(`Polymarket API ${response.status}: ${await response.text()}`);
      }

      const body = await response.json();
      if (Array.isArray(body)) return body as T[];
      if (body && typeof body === "object") {
        const maybeList = body as { value?: unknown; data?: unknown };
        if (Array.isArray(maybeList.value)) return maybeList.value as T[];
        if (Array.isArray(maybeList.data)) return maybeList.data as T[];
      }
      return [];
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(500);
    }
  }

  throw lastError;
}

function renderResults(rows: Array<{ live: LiveCandidate; summary: ReturnType<typeof analyzeCandidate> }>, now: number): string {
  if (rows.length === 0) {
    return "No wallet met the live + historical filters in this pass.";
  }

  const lines = [
    `Generated: ${new Date(now * 1000).toISOString()}`,
    `Filters: active <=30m, first trade <=${EARLY_SECONDS}s into market, one historical side >=80%, win rate >=55%, positive ${HISTORY_DAYS}d PnL from latest ${HISTORY_PAGES * HISTORY_PAGE_SIZE} activity rows`,
    "",
    "| # | Wallet | Name | Live markets | Live buy | Last trade UTC | Hist markets | Win % | PnL | ROI % | Early % | One-sided % |",
    "|---:|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|"
  ];

  rows.forEach(({ live, summary }, index) => {
    lines.push(
      [
        index + 1,
        `\`${live.wallet}\``,
        live.name ?? "",
        live.recentMarkets,
        money(live.recentBuyCost),
        new Date(live.latestTradeTimestamp * 1000).toISOString(),
        summary.totalMarkets,
        percent(summary.winRate),
        money(summary.totalPnl),
        percent(summary.roi),
        percent(summary.earlyEntryRate),
        percent(summary.oneSidedRate)
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    );
  });

  return lines.join("\n");
}

function readJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function money(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
