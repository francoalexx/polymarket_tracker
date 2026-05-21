import type { Response } from "express";
import WebSocket from "ws";
import { getActivityId, groupPositions } from "../shared/polymarket";
import type { ActivityTrade, ErrorPayload, PositionLeg, PriceUpdate, StatusPayload } from "../shared/types";
import { PolymarketClient } from "./polymarketClient";

const MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const ACTIVITY_MS = 1000;
const POSITIONS_MS = 3000;
const STALE_MS = 10000;
const PENDING_TRADE_TTL_MS = 15000;
const BURST_POSITIONS_MS = 400;
const BURST_POSITIONS_POLLS = 8;

export class StreamSession {
  private readonly client = new PolymarketClient();
  private readonly seenActivity = new Set<string>();
  private readonly pendingTrades = new Map<string, { trade: ActivityTrade; receivedAt: number }>();
  private activity: ActivityTrade[] = [];
  private positions: PositionLeg[] = [];
  private activityTimer?: NodeJS.Timeout;
  private positionsTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private burstTimer?: NodeJS.Timeout;
  private ws?: WebSocket;
  private closed = false;
  private lastPositionsAt = 0;
  private burstPollsRemaining = 0;
  private positionsInFlight = false;
  private queuedPositionsPoll = false;

  constructor(
    private readonly wallet: string,
    private readonly response: Response
  ) {}

  start(): void {
    this.send("status", status("connecting", "Connecting to Polymarket data streams"));
    void this.pollActivity(true);
    this.requestPositionsPoll();

    this.activityTimer = setInterval(() => void this.pollActivity(false), ACTIVITY_MS);
    this.positionsTimer = setInterval(() => this.requestPositionsPoll(), POSITIONS_MS);
    this.staleTimer = setInterval(() => this.checkStaleness(), 1000);
  }

  close(): void {
    this.closed = true;
    if (this.activityTimer) clearInterval(this.activityTimer);
    if (this.positionsTimer) clearInterval(this.positionsTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.burstTimer) clearInterval(this.burstTimer);
    this.ws?.close();
    this.send("status", status("closed", "Stream closed"));
  }

  private requestPositionsPoll(): void {
    if (this.closed) return;

    if (this.positionsInFlight) {
      this.queuedPositionsPoll = true;
      return;
    }

    void this.pollPositions();
  }

  private async pollPositions(): Promise<void> {
    this.positionsInFlight = true;

    try {
      const positions = await this.client.getPositions(this.wallet);
      if (this.closed) return;

      this.positions = positions;
      this.lastPositionsAt = Date.now();
      this.prunePendingTrades();

      this.sendPositionsSnapshot();

      for (const position of positions) {
        this.send("price_update", {
          asset: position.asset,
          price: Number(position.curPrice),
          receivedAt: Date.now(),
          source: "positions"
        } satisfies PriceUpdate);
      }

      this.refreshMarketSocket(this.subscribedAssets());
      this.send("status", status("live", "Live"));
    } catch (error) {
      this.reportError(error);
    } finally {
      this.positionsInFlight = false;
      if (this.queuedPositionsPoll && !this.closed) {
        this.queuedPositionsPoll = false;
        this.requestPositionsPoll();
      }
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
        this.trackPendingTrades(fresh);
        this.sendPositionsSnapshot();
        this.refreshMarketSocket(this.subscribedAssets());
        this.scheduleBurstPositions();

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

  private sendPositionsSnapshot(): void {
    this.prunePendingTrades();
    this.send("positions_snapshot", {
      wallet: this.wallet,
      receivedAt: Date.now(),
      groups: groupPositions(this.positions, this.activity, { pendingTrades: this.pendingActivity() }),
      rawCount: this.positions.length
    });
  }

  private trackPendingTrades(trades: ActivityTrade[]): void {
    const receivedAt = Date.now();

    for (const trade of trades) {
      if (trade.side !== "BUY") continue;

      this.pendingTrades.set(getActivityId(trade), { trade, receivedAt });
      this.send("price_update", {
        asset: trade.asset,
        price: Number(trade.price),
        receivedAt,
        source: "positions"
      } satisfies PriceUpdate);
    }

    this.prunePendingTrades();
  }

  private pendingActivity(): ActivityTrade[] {
    return Array.from(this.pendingTrades.values()).map(({ trade }) => trade);
  }

  private prunePendingTrades(): void {
    const positionConditionIds = new Set(this.positions.map((position) => position.conditionId));
    const now = Date.now();

    for (const [id, pending] of this.pendingTrades) {
      if (positionConditionIds.has(pending.trade.conditionId) || now - pending.receivedAt > PENDING_TRADE_TTL_MS) {
        this.pendingTrades.delete(id);
      }
    }
  }

  private subscribedAssets(): string[] {
    return [...this.positions.map((position) => position.asset), ...this.pendingActivity().map((trade) => trade.asset)];
  }

  private scheduleBurstPositions(): void {
    this.burstPollsRemaining = Math.max(this.burstPollsRemaining, BURST_POSITIONS_POLLS);
    this.requestPositionsPoll();

    if (this.burstTimer) return;

    this.burstTimer = setInterval(() => {
      if (this.closed || this.burstPollsRemaining <= 0) {
        if (this.burstTimer) clearInterval(this.burstTimer);
        this.burstTimer = undefined;
        return;
      }

      this.burstPollsRemaining -= 1;
      this.requestPositionsPoll();
    }, BURST_POSITIONS_MS);
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
