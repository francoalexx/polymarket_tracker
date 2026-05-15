import { getActivityId } from "../shared/polymarket";
import type { ActivityTrade, GammaEvent, GammaMarket, LeaderboardTrader, PositionLeg } from "../shared/types";

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
