import { getActivityId } from "../shared/polymarket";
import type { ActivityTrade, GammaEvent, GammaMarket, LeaderboardTrader, MarketMetadata, MarketType, PositionLeg } from "../shared/types";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const MAX_ACTIVITY_OFFSET = 3000;
const ACTIVITY_LIMIT = 500;
const MIN_ACTIVITY_SLICE_SECONDS = 300;

export class PolymarketClient {
  async getPositions(wallet: string): Promise<PositionLeg[]> {
    const url = new URL("/positions", DATA_API);
    url.searchParams.set("user", wallet);
    url.searchParams.set("limit", "500");
    url.searchParams.set("sizeThreshold", "0");
    url.searchParams.set("sortBy", "CURRENT");
    url.searchParams.set("sortDirection", "DESC");

    return readList<PositionLeg>(await fetchJson(url));
  }

  async getActivity(wallet: string): Promise<ActivityTrade[]> {
    const url = new URL("/activity", DATA_API);
    url.searchParams.set("user", wallet);
    url.searchParams.set("limit", "100");
    url.searchParams.set("type", "TRADE");
    url.searchParams.set("sortDirection", "DESC");

    return readList<ActivityTrade>(await fetchJson(url));
  }

  async getActivityRange(wallet: string, start: number, end: number): Promise<ActivityTrade[]> {
    const trades = await this.getActivityRangePageable(wallet, start, end);
    const deduped = new Map<string, ActivityTrade>();

    for (const trade of trades) {
      deduped.set(getActivityId(trade), trade);
    }

    return Array.from(deduped.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  async getLeaderboardTraders(options: {
    category?: "OVERALL" | "POLITICS" | "SPORTS" | "CRYPTO" | "CULTURE" | "MENTIONS" | "WEATHER" | "ECONOMICS" | "TECH" | "FINANCE";
    timePeriod?: "DAY" | "WEEK" | "MONTH" | "ALL";
    orderBy?: "PNL" | "VOL";
    limit?: number;
  } = {}): Promise<LeaderboardTrader[]> {
    const total = options.limit ?? 250;
    const pageSize = 50;
    const traders: LeaderboardTrader[] = [];

    for (let offset = 0; traders.length < total && offset <= 1000; offset += pageSize) {
      const url = new URL("/v1/leaderboard", DATA_API);
      url.searchParams.set("category", options.category ?? "CRYPTO");
      url.searchParams.set("timePeriod", options.timePeriod ?? "WEEK");
      url.searchParams.set("orderBy", options.orderBy ?? "PNL");
      url.searchParams.set("limit", String(Math.min(pageSize, total - traders.length)));
      url.searchParams.set("offset", String(offset));

      const page = readList<LeaderboardTrader>(await fetchJson(url));
      traders.push(...page);
      if (page.length < pageSize) break;
    }

    return traders.slice(0, total);
  }

  async getGammaMarketBySlug(slug: string): Promise<GammaMarket | undefined> {
    const url = new URL("/events", GAMMA_API);
    url.searchParams.set("slug", slug);

    const [event] = readList<GammaEvent>(await fetchJson(url));
    return event?.markets?.find((market) => market.slug === slug);
  }

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

  private async getActivityRangePageable(wallet: string, start: number, end: number): Promise<ActivityTrade[]> {
    const rows: ActivityTrade[] = [];

    for (let offset = 0; offset <= MAX_ACTIVITY_OFFSET; offset += ACTIVITY_LIMIT) {
      const page = await this.getActivityPage(wallet, start, end, offset);
      rows.push(...page);
      if (page.length < ACTIVITY_LIMIT) return rows;
    }

    if (end - start <= MIN_ACTIVITY_SLICE_SECONDS) {
      return rows;
    }

    const midpoint = Math.floor((start + end) / 2);
    const left = await this.getActivityRangePageable(wallet, start, midpoint);
    const right = await this.getActivityRangePageable(wallet, midpoint + 1, end);
    return [...left, ...right];
  }

  private async getActivityPage(wallet: string, start: number, end: number, offset: number): Promise<ActivityTrade[]> {
    const url = new URL("/activity", DATA_API);
    url.searchParams.set("user", wallet);
    url.searchParams.set("limit", String(ACTIVITY_LIMIT));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("type", "TRADE");
    url.searchParams.set("start", String(start));
    url.searchParams.set("end", String(end));
    url.searchParams.set("sortDirection", "ASC");

    return readList<ActivityTrade>(await fetchJson(url));
  }
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "bonereaper-polymarket-tracker/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Polymarket API ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function readList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object") {
    const maybeList = body as { value?: unknown; data?: unknown };
    if (Array.isArray(maybeList.value)) return maybeList.value as T[];
    if (Array.isArray(maybeList.data)) return maybeList.data as T[];
  }
  return [];
}

export function marketMetadataFromGammaMarket(market: GammaMarket, marketType: MarketType): MarketMetadata | undefined {
  if (!market.conditionId || market.closed || market.active === false || market.acceptingOrders === false) return undefined;

  const outcomes = readJsonArray(market.outcomes).map(String);
  const tokenIds = readJsonArray(market.clobTokenIds ?? "[]").map(String);
  const prices = readJsonArray(market.outcomePrices).map((price) => Number(price));
  if (outcomes.length === 0 || outcomes.length !== tokenIds.length) return undefined;
  if (prices.length !== outcomes.length || prices.some((price) => !Number.isFinite(price))) return undefined;

  const startValue = market.eventStartTime ?? getStartIsoFromSlug(market.slug) ?? market.startDate;
  if (!startValue || !market.endDate) return undefined;
  const startTimestamp = Math.floor(Date.parse(startValue) / 1000);
  const endTimestamp = Math.floor(Date.parse(market.endDate) / 1000);
  if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) return undefined;

  const parsedMinTickSize = Number(market.orderPriceMinTickSize);
  const minTickSize = Number.isFinite(parsedMinTickSize) && parsedMinTickSize > 0 ? parsedMinTickSize : 0.01;

  return {
    conditionId: market.conditionId,
    slug: market.slug,
    title: market.question,
    marketType,
    startTimestamp,
    endTimestamp,
    outcomes: outcomes.map((name, index) => ({ name, tokenId: tokenIds[index], price: prices[index] })),
    minTickSize,
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
