import { describe, expect, it } from "vitest";
import { analyzeCandidate, isBtcFiveMinuteTrade } from "../shared/candidateScanner";
import { getActivityId, groupPositions, isShortTermCryptoMarket, isValidWallet, normalizeWallet } from "../shared/polymarket";
import type { ActivityTrade, PositionLeg } from "../shared/types";

describe("wallet helpers", () => {
  it("validates and normalizes wallet addresses", () => {
    expect(isValidWallet("0xeebde7a0e019a63e6b476eb425505b7b3e6eba30")).toBe(true);
    expect(isValidWallet("bonereaper")).toBe(false);
    expect(normalizeWallet(" 0xEEBDE7A0E019A63E6B476EB425505B7B3E6EBA30 ")).toBe(
      "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30"
    );
  });
});

describe("market classifiers", () => {
  it("pins short-term crypto markets", () => {
    expect(isShortTermCryptoMarket({ title: "Bitcoin Up or Down - May 12, 5:00PM-5:15PM ET", slug: "btc-updown-15m-1" })).toBe(
      true
    );
    expect(isShortTermCryptoMarket({ title: "Election winner", slug: "election-winner" })).toBe(false);
  });
});

describe("activity dedupe", () => {
  it("uses all required trade fields in the activity id", () => {
    const base = trade({ price: 0.55, size: 10 });
    expect(getActivityId(base)).toBe(getActivityId(trade({ price: 0.55, size: 10 })));
    expect(getActivityId(base)).not.toBe(getActivityId(trade({ price: 0.56, size: 10 })));
    expect(getActivityId(base)).not.toBe(getActivityId(trade({ price: 0.55, size: 11 })));
  });
});

describe("position grouping", () => {
  it("groups Up and Down legs, computes totals, dominant outcome, and latest trade", () => {
    const up = position({ outcome: "Up", outcomeIndex: 0, size: 120, currentValue: 72, cashPnl: 12, avgPrice: 0.5 });
    const down = position({ outcome: "Down", outcomeIndex: 1, size: 40, currentValue: 18, cashPnl: -2, avgPrice: 0.4 });
    const older = position({ conditionId: "0xother", title: "Election winner", slug: "election-winner", currentValue: 500 });

    const groups = groupPositions([older, down, up], [trade({ conditionId: up.conditionId, timestamp: 200 }), trade({ conditionId: up.conditionId, timestamp: 300 })]);

    expect(groups[0].conditionId).toBe(up.conditionId);
    expect(groups[0].isShortTermCrypto).toBe(true);
    expect(groups[0].legs.map((leg) => leg.outcome)).toEqual(["Up", "Down"]);
    expect(groups[0].totalCurrentValue).toBe(90);
    expect(groups[0].totalCashPnl).toBe(10);
    expect(groups[0].dominantOutcome).toBe("Up");
    expect(groups[0].lastTradeTimestamp).toBe(300);
  });

  it("creates pending groups from fresh activity before positions catch up", () => {
    const fresh = trade({ conditionId: "0xfresh", outcome: "Down", asset: "down-asset", size: 25, usdcSize: 9.75, price: 0.39 });

    const groups = groupPositions([], [fresh], { pendingTrades: [fresh] });

    expect(groups).toHaveLength(1);
    expect(groups[0].conditionId).toBe("0xfresh");
    expect(groups[0].isPending).toBe(true);
    expect(groups[0].dominantOutcome).toBe("Down");
    expect(groups[0].totalShares).toBe(25);
    expect(groups[0].totalCurrentValue).toBe(9.75);
    expect(groups[0].lastTradeTimestamp).toBe(fresh.timestamp);
  });

  it("skips pending activity groups once a real position exists", () => {
    const fresh = trade({ conditionId: "0xfresh", outcome: "Down", asset: "down-asset" });
    const real = position({ conditionId: "0xfresh", outcome: "Down", asset: "down-asset", currentValue: 12 });

    const groups = groupPositions([real], [fresh], { pendingTrades: [fresh] });

    expect(groups).toHaveLength(1);
    expect(groups[0].isPending).toBe(false);
    expect(groups[0].totalCurrentValue).toBe(12);
  });
});

describe("candidate scanner", () => {
  it("filters activity to BTC 5-minute markets", () => {
    expect(isBtcFiveMinuteTrade(trade({ title: "Bitcoin Up or Down - May 9, 4:30AM-4:35AM ET", slug: "btc-updown-5m-1778315400" }))).toBe(true);
    expect(isBtcFiveMinuteTrade(trade({ title: "Bitcoin Up or Down - May 9, 4:30AM-4:45AM ET", slug: "btc-updown-15m-1778315400" }))).toBe(false);
    expect(isBtcFiveMinuteTrade(trade({ title: "Ethereum Up or Down - May 9, 4:30AM-4:35AM ET", slug: "eth-updown-5m-1778315400" }))).toBe(false);
  });

  it("scores wallets by market-level PnL, early entry, and one-sided behavior", () => {
    const summary = analyzeCandidate(
      {
        proxyWallet: "0xcandidate",
        userName: "candidate",
        rank: "1",
        pnl: 1000,
        vol: 5000
      },
      [
        trade({
          conditionId: "0xwin",
          slug: "btc-updown-5m-1000",
          title: "Bitcoin Up or Down - Test A",
          timestamp: 1020,
          side: "BUY",
          outcome: "Up",
          size: 100,
          usdcSize: 40
        }),
        trade({
          conditionId: "0xloss",
          slug: "btc-updown-5m-2000",
          title: "Bitcoin Up or Down - Test B",
          timestamp: 2170,
          side: "BUY",
          outcome: "Down",
          size: 100,
          usdcSize: 30
        }),
        trade({
          conditionId: "0xhedged",
          slug: "btc-updown-5m-3000",
          title: "Bitcoin Up or Down - Test C",
          timestamp: 3030,
          side: "BUY",
          outcome: "Up",
          size: 10,
          usdcSize: 4
        }),
        trade({
          conditionId: "0xhedged",
          slug: "btc-updown-5m-3000",
          title: "Bitcoin Up or Down - Test C",
          timestamp: 3040,
          side: "BUY",
          outcome: "Down",
          size: 20,
          usdcSize: 6
        })
      ],
      new Map([
        ["0xwin", "Up"],
        ["0xloss", "Up"],
        ["0xhedged", "Down"]
      ]),
      { earlyEntrySeconds: 90 }
    );

    expect(summary.totalMarkets).toBe(3);
    expect(summary.wins).toBe(2);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBeCloseTo(2 / 3);
    expect(summary.totalPnl).toBeCloseTo(40);
    expect(summary.earlyEntryRate).toBeCloseTo(2 / 3);
    expect(summary.oneSidedRate).toBeCloseTo(2 / 3);
    expect(summary.holdThroughRate).toBe(1);
    expect(summary.copyabilityScore).toBeGreaterThan(60);
    expect(summary.copyabilityScore).toBeLessThan(80);
  });
});

function position(overrides: Partial<PositionLeg> = {}): PositionLeg {
  return {
    proxyWallet: "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30",
    asset: overrides.outcome === "Down" ? "down-asset" : "up-asset",
    conditionId: "0xcondition",
    size: 100,
    avgPrice: 0.5,
    initialValue: 50,
    currentValue: 50,
    cashPnl: 0,
    percentPnl: 0,
    totalBought: 100,
    realizedPnl: 0,
    percentRealizedPnl: 0,
    curPrice: 0.5,
    redeemable: false,
    mergeable: false,
    title: "Bitcoin Up or Down - May 12, 5:00PM-5:15PM ET",
    slug: "btc-updown-15m-1778619600",
    icon: "btc.png",
    eventId: "1",
    eventSlug: "btc-updown-15m-1778619600",
    outcome: "Up",
    outcomeIndex: 0,
    oppositeOutcome: "Down",
    oppositeAsset: "down-asset",
    endDate: "2026-05-12",
    negativeRisk: false,
    ...overrides
  };
}

function trade(overrides: Partial<ActivityTrade> = {}): ActivityTrade {
  return {
    proxyWallet: "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30",
    timestamp: 100,
    conditionId: "0xcondition",
    type: "TRADE",
    size: 10,
    usdcSize: 5.5,
    transactionHash: "0xtrade",
    price: 0.55,
    asset: "up-asset",
    side: "BUY",
    outcomeIndex: 0,
    title: "Bitcoin Up or Down - May 12, 5:00PM-5:15PM ET",
    slug: "btc-updown-15m-1778619600",
    icon: "btc.png",
    eventSlug: "btc-updown-15m-1778619600",
    outcome: "Up",
    ...overrides
  };
}
