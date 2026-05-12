import { describe, expect, it } from "vitest";
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
