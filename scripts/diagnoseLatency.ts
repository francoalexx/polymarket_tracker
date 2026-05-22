import { PolymarketClient } from "../server/polymarketClient";
import type { ActivityTrade } from "../shared/types";

const client = new PolymarketClient();

type LatencyRow = {
  wallet: string;
  market: string;
  side: string;
  outcome: string;
  tradeAgeSeconds: number;
  appearsInActivity: boolean;
  activityNewestAgeSeconds?: number;
};

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const markets = await client.getShortTermBtcMarkets({ marketType: "5m", now, lookbackMarkets: 4 });
  const trades = await client.getTradesByMarkets(markets.map((market) => market.conditionId));
  const newest = [...trades].sort((left, right) => right.timestamp - left.timestamp).slice(0, 20);
  const activityByWallet = new Map<string, Promise<ActivityTrade[]>>();
  const rows: LatencyRow[] = [];

  for (const trade of newest) {
    const wallet = trade.proxyWallet.trim().toLowerCase();
    const activityPromise = activityByWallet.get(wallet) ?? client.getActivity(wallet);
    activityByWallet.set(wallet, activityPromise);

    const activity = await activityPromise;
    const activityMatch = activity.find((candidate) => candidate.transactionHash === trade.transactionHash && candidate.asset === trade.asset);
    rows.push({
      wallet,
      market: trade.slug,
      side: trade.side,
      outcome: trade.outcome,
      tradeAgeSeconds: now - trade.timestamp,
      appearsInActivity: Boolean(activityMatch),
      activityNewestAgeSeconds: activity[0] ? now - activity[0].timestamp : undefined
    });
  }

  if (rows.length === 0) {
    console.log("No recent BTC 5m market trades found.");
    return;
  }

  console.table(rows);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
