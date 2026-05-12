import type { Response } from "express";
import WebSocket from "ws";
import { getActivityId, groupPositions } from "../shared/polymarket";
import type { ActivityTrade, ErrorPayload, PositionLeg, PriceUpdate, StatusPayload } from "../shared/types";
import { PolymarketClient } from "./polymarketClient";

const MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const ACTIVITY_MS = 1000;
const POSITIONS_MS = 3000;
const STALE_MS = 10000;

export class StreamSession {
  private readonly client = new PolymarketClient();
  private readonly seenActivity = new Set<string>();
  private activity: ActivityTrade[] = [];
  private positions: PositionLeg[] = [];
  private activityTimer?: NodeJS.Timeout;
  private positionsTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private ws?: WebSocket;
  private closed = false;
  private lastPositionsAt = 0;

  constructor(
    private readonly wallet: string,
    private readonly response: Response
  ) {}

  start(): void {
    this.send("status", status("connecting", "Connecting to Polymarket data streams"));
    void this.pollActivity(true);
    void this.pollPositions();

    this.activityTimer = setInterval(() => void this.pollActivity(false), ACTIVITY_MS);
    this.positionsTimer = setInterval(() => void this.pollPositions(), POSITIONS_MS);
    this.staleTimer = setInterval(() => this.checkStaleness(), 1000);
  }

  close(): void {
    this.closed = true;
    if (this.activityTimer) clearInterval(this.activityTimer);
    if (this.positionsTimer) clearInterval(this.positionsTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.ws?.close();
    this.send("status", status("closed", "Stream closed"));
  }

  private async pollPositions(): Promise<void> {
    try {
      const positions = await this.client.getPositions(this.wallet);
      if (this.closed) return;

      this.positions = positions;
      this.lastPositionsAt = Date.now();

      this.send("positions_snapshot", {
        wallet: this.wallet,
        receivedAt: this.lastPositionsAt,
        groups: groupPositions(this.positions, this.activity),
        rawCount: this.positions.length
      });

      for (const position of positions) {
        this.send("price_update", {
          asset: position.asset,
          price: Number(position.curPrice),
          receivedAt: Date.now(),
          source: "positions"
        } satisfies PriceUpdate);
      }

      this.refreshMarketSocket(positions.map((position) => position.asset));
      this.send("status", status("live", "Live"));
    } catch (error) {
      this.reportError(error);
    }
  }

  private async pollActivity(seedOnly: boolean): Promise<void> {
    try {
      const activity = await this.client.getActivity(this.wallet);
      if (this.closed) return;

      const newestFirst = activity.sort((a, b) => b.timestamp - a.timestamp);
      const fresh: ActivityTrade[] = [];

      for (const trade of newestFirst) {
        const id = getActivityId(trade);
        if (!this.seenActivity.has(id)) {
          this.seenActivity.add(id);
          if (!seedOnly) fresh.push(trade);
        }
      }

      this.activity = newestFirst.slice(0, 250);

      if (fresh.length > 0) {
        this.send("activity_delta", {
          wallet: this.wallet,
          receivedAt: Date.now(),
          trades: fresh.reverse()
        });
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private refreshMarketSocket(assets: string[]): void {
    const uniqueAssets = Array.from(new Set(assets)).filter(Boolean);
    if (uniqueAssets.length === 0) return;

    const assetKey = uniqueAssets.join(",");
    if ((this.ws as WebSocket & { assetKey?: string } | undefined)?.assetKey === assetKey) return;

    this.ws?.close();
    const ws = new WebSocket(MARKET_WS);
    (ws as WebSocket & { assetKey?: string }).assetKey = assetKey;
    this.ws = ws;

    ws.on("open", () => {
      ws.send(JSON.stringify({ assets_ids: uniqueAssets, type: "market" }));
    });

    ws.on("message", (data) => {
      for (const update of parsePriceUpdates(data.toString())) {
        this.send("price_update", update);
      }
    });

    ws.on("close", () => {
      if (!this.closed) this.send("status", status("reconnecting", "Market price stream reconnecting"));
    });

    ws.on("error", (error) => {
      this.reportError(error);
    });
  }

  private checkStaleness(): void {
    if (this.lastPositionsAt > 0 && Date.now() - this.lastPositionsAt > STALE_MS) {
      this.send("status", status("stale", "Position data is more than 10 seconds old"));
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.send("error", { message, receivedAt: Date.now() } satisfies ErrorPayload);
  }

  private send(event: string, payload: unknown): void {
    if (this.closed && event !== "status") return;
    this.response.write(`event: ${event}\n`);
    this.response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function status(statusValue: StatusPayload["status"], message: string): StatusPayload {
  return { status: statusValue, message, receivedAt: Date.now() };
}

function parsePriceUpdates(raw: string): PriceUpdate[] {
  try {
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed) ? parsed : [parsed];

    return messages
      .map((message) => {
        const asset = message.asset_id ?? message.asset ?? message.token_id;
        if (!asset) return undefined;

        const price = parseNumeric(message.price ?? message.last_trade_price ?? message.last_price);
        const bid = parseNumeric(message.best_bid ?? message.bid);
        const ask = parseNumeric(message.best_ask ?? message.ask);

        return {
          asset: String(asset),
          price,
          bid,
          ask,
          receivedAt: Date.now(),
          source: "websocket" as const
        };
      })
      .filter(Boolean) as PriceUpdate[];
  } catch {
    return [];
  }
}

function parseNumeric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
