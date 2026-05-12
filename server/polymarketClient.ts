import type { ActivityTrade, PositionLeg } from "../shared/types";

const DATA_API = "https://data-api.polymarket.com";

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
