import { describe, expect, it } from "vitest";
import { marketMetadataFromGammaMarket } from "../server/polymarketClient";
import { ScannerService } from "../server/scannerService";
import { analyzeCandidate, isBtcFiveMinuteTrade } from "../shared/candidateScanner";
import {
  buildEntryTicket,
  buildExitTicket,
  getLatencyMode,
  isBtcShortTermTrade,
  shouldSuppressRepeatSignal,
  summarizeLiveWallet,
  passesStrictHistory
} from "../shared/copyTrader";
import { getActivityId, groupPositions, isShortTermCryptoMarket, isValidWallet, normalizeWallet } from "../shared/polymarket";
import type { CandidateSummary } from "../shared/candidateScanner";
import type { ActivityTrade, GammaMarket, PositionLeg } from "../shared/types";
import type { CopyTraderConfig, MarketMetadata, SignalCooldownKey } from "../shared/types";

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

describe("Polymarket live market metadata", () => {
  it("converts Gamma market fields into scanner market metadata", () => {
    const market = marketMetadataFromGammaMarket(
      {
        question: "Bitcoin Up or Down",
        conditionId: "0xcondition",
        slug: "btc-updown-5m-1778315400",
        endDate: "2026-05-21T12:05:00Z",
        outcomes: "[\"Up\",\"Down\"]",
        outcomePrices: "[\"0.54\",\"0.46\"]",
        closed: false,
        clobTokenIds: "[\"up-token\",\"down-token\"]",
        orderPriceMinTickSize: 0.01,
        negRisk: false,
        active: true,
        acceptingOrders: true,
        eventStartTime: "2026-05-21T12:00:00Z",
        startDate: "2026-05-21T12:00:00Z"
      },
      "5m"
    );

    expect(market).toEqual({
      conditionId: "0xcondition",
      slug: "btc-updown-5m-1778315400",
      title: "Bitcoin Up or Down",
      marketType: "5m",
      startTimestamp: 1779364800,
      endTimestamp: 1779365100,
      outcomes: [
        { name: "Up", tokenId: "up-token", price: 0.54 },
        { name: "Down", tokenId: "down-token", price: 0.46 }
      ],
      minTickSize: 0.01,
      negRisk: false
    });
  });

  it("prefers eventStartTime over older startDate and slug timestamps", () => {
    const market = marketMetadataFromGammaMarket(
      gammaMarket({
        slug: "btc-updown-5m-1778315400",
        eventStartTime: "2026-05-21T12:02:00Z",
        startDate: "2026-05-20T12:00:00Z",
        endDate: "2026-05-21T12:07:00Z"
      }),
      "5m"
    );

    expect(market?.startTimestamp).toBe(1779364920);
    expect(market?.endTimestamp).toBe(1779365220);
  });

  it("falls back to the slug timestamp before startDate", () => {
    const market = marketMetadataFromGammaMarket(
      gammaMarket({
        slug: "btc-updown-5m-1778315400",
        startDate: "2026-05-20T12:00:00Z"
      }),
      "5m"
    );

    expect(market?.startTimestamp).toBe(1778315400);
  });

  it("ignores absurd slug timestamps and falls back to startDate", () => {
    const market = marketMetadataFromGammaMarket(
      gammaMarket({
        slug: "btc-updown-5m-999999999999999999999999999999",
        startDate: "2026-05-21T12:00:00Z"
      }),
      "5m"
    );

    expect(market?.startTimestamp).toBe(1779364800);
  });

  it("skips closed, inactive, and non-orderable Gamma markets", () => {
    expect(marketMetadataFromGammaMarket(gammaMarket({ closed: true }), "5m")).toBeUndefined();
    expect(marketMetadataFromGammaMarket(gammaMarket({ active: false }), "5m")).toBeUndefined();
    expect(marketMetadataFromGammaMarket(gammaMarket({ acceptingOrders: false }), "5m")).toBeUndefined();
  });

  it("skips markets with malformed, mismatched, or non-finite prices", () => {
    expect(marketMetadataFromGammaMarket(gammaMarket({ outcomePrices: "not-json" }), "5m")).toBeUndefined();
    expect(marketMetadataFromGammaMarket(gammaMarket({ outcomePrices: "[\"0.54\"]" }), "5m")).toBeUndefined();
    expect(marketMetadataFromGammaMarket(gammaMarket({ outcomePrices: "[\"0.54\",\"NaN\"]" }), "5m")).toBeUndefined();
    expect(marketMetadataFromGammaMarket(gammaMarket({ outcomePrices: "[null,\"0.46\"]" }), "5m")).toBeUndefined();
    expect(marketMetadataFromGammaMarket(gammaMarket({ outcomePrices: "[\"\",\"0.46\"]" }), "5m")).toBeUndefined();
    expect(marketMetadataFromGammaMarket(gammaMarket({ outcomePrices: "[false,\"0.46\"]" }), "5m")).toBeUndefined();
  });

  it("skips markets with invalid start or end dates", () => {
    expect(marketMetadataFromGammaMarket(gammaMarket({ slug: "btc-updown-5m-invalid", eventStartTime: "not-a-date" }), "5m")).toBeUndefined();
    expect(marketMetadataFromGammaMarket(gammaMarket({ endDate: "not-a-date" }), "5m")).toBeUndefined();
  });

  it("defaults invalid min tick sizes and missing negative risk", () => {
    const missing = marketMetadataFromGammaMarket(
      gammaMarket({
        negRisk: undefined,
        orderPriceMinTickSize: undefined
      }),
      "5m"
    );
    const invalid = marketMetadataFromGammaMarket(gammaMarket({ orderPriceMinTickSize: "not-a-number" }), "5m");
    const nonPositive = marketMetadataFromGammaMarket(gammaMarket({ orderPriceMinTickSize: 0 }), "5m");

    expect(missing?.minTickSize).toBe(0.01);
    expect(missing?.negRisk).toBe(false);
    expect(invalid?.minTickSize).toBe(0.01);
    expect(nonPositive?.minTickSize).toBe(0.01);
  });
});

describe("hybrid copy trader pure logic", () => {
  const config: CopyTraderConfig = {
    primaryMarketType: "5m",
    fallbackMarketType: "15m",
    latencyThresholdSeconds: 8,
    activeWithinSeconds: 20 * 60,
    earlyEntrySeconds: 90,
    minLiveTradeUsdc: 5,
    maxEntryPrice: 0.85,
    repeatCooldownSeconds: 240,
    defaultEntrySpendUsdc: 10,
    maxSlippageCents: 5
  };

  it("classifies BTC 5m and BTC 15m trades without matching ETH", () => {
    expect(isBtcShortTermTrade(trade({ slug: "btc-updown-5m-1778315400" }), "5m")).toBe(true);
    expect(isBtcShortTermTrade(trade({ slug: "btc-updown-15m-1778315400" }), "15m")).toBe(true);
    expect(isBtcShortTermTrade(trade({ slug: "btc-updown-15m-1778315400" }), "5m")).toBe(false);
    expect(isBtcShortTermTrade(trade({ slug: "eth-updown-5m-1778315400", title: "Ethereum Up or Down" }), "5m")).toBe(false);
  });

  it("marks BTC 5m as degraded when median latency exceeds threshold", () => {
    expect(getLatencyMode([{ latencySeconds: 3 }, { latencySeconds: 5 }, { latencySeconds: 7 }], config)).toEqual({
      activeMarketType: "5m",
      isDegraded: false,
      medianLatencySeconds: 5
    });
    expect(getLatencyMode([{ latencySeconds: 9 }, { latencySeconds: 11 }, { latencySeconds: 20 }], config)).toEqual({
      activeMarketType: "15m",
      isDegraded: true,
      medianLatencySeconds: 11
    });
  });

  it("summarizes an early one-sided live wallet and rejects dust or late entries", () => {
    const market: MarketMetadata = {
      conditionId: "0xlive",
      slug: "btc-updown-5m-1000",
      title: "Bitcoin Up or Down",
      marketType: "5m",
      startTimestamp: 1000,
      endTimestamp: 1300,
      outcomes: [
        { name: "Up", tokenId: "up-token", price: 0.54 },
        { name: "Down", tokenId: "down-token", price: 0.46 }
      ],
      minTickSize: 0.01,
      negRisk: false
    };

    const signal = summarizeLiveWallet(
      "0xlivewallet00000000000000000000000000000000",
      [
        trade({
          proxyWallet: "0xlivewallet00000000000000000000000000000000",
          conditionId: "0xlive",
          slug: market.slug,
          timestamp: 1020,
          side: "BUY",
          outcome: "Up",
          asset: "up-token",
          size: 30,
          usdcSize: 16.2,
          price: 0.54
        })
      ],
      market,
      1040,
      config
    );

    expect(signal?.recommendation).toBe("prepare_entry");
    expect(signal?.firstEntrySeconds).toBe(20);
    expect(signal?.isOneSided).toBe(true);

    expect(
      summarizeLiveWallet(
        "0xdustwallet000000000000000000000000000000000",
        [
          trade({
            proxyWallet: "0xdustwallet000000000000000000000000000000000",
            conditionId: "0xlive",
            slug: market.slug,
            timestamp: 1020,
            usdcSize: 1,
            price: 0.54
          })
        ],
        market,
        1040,
        config
      )
    ).toBeUndefined();

    expect(
      summarizeLiveWallet(
        "0xlatewallet000000000000000000000000000000000",
        [
          trade({
            proxyWallet: "0xlatewallet000000000000000000000000000000000",
            conditionId: "0xlive",
            slug: market.slug,
            timestamp: 1210,
            usdcSize: 20,
            price: 0.54
          })
        ],
        market,
        1220,
        config
      )?.recommendation
    ).toBe("watch");
  });

  it("summarizes live wallet activity using only the requested wallet", () => {
    const market: MarketMetadata = {
      conditionId: "0xshared",
      slug: "btc-updown-5m-1500",
      title: "Bitcoin Up or Down",
      marketType: "5m",
      startTimestamp: 1500,
      endTimestamp: 1800,
      outcomes: [
        { name: "Up", tokenId: "up-token", price: 0.52 },
        { name: "Down", tokenId: "down-token", price: 0.48 }
      ],
      minTickSize: 0.01,
      negRisk: false
    };

    const signal = summarizeLiveWallet(
      "0xcasewallet00000000000000000000000000000000",
      [
        trade({
          proxyWallet: "0xotherwallet0000000000000000000000000000000",
          conditionId: "0xshared",
          slug: market.slug,
          timestamp: 1510,
          side: "BUY",
          outcome: "Down",
          asset: "down-token",
          size: 50,
          usdcSize: 24,
          price: 0.48
        }),
        trade({
          proxyWallet: "0xCASEWALLET00000000000000000000000000000000",
          conditionId: "0xshared",
          slug: market.slug,
          timestamp: 1520,
          side: "BUY",
          outcome: "Up",
          asset: "up-token",
          size: 20,
          usdcSize: 10.4,
          price: 0.52
        }),
        trade({
          proxyWallet: "0xotherwallet0000000000000000000000000000000",
          conditionId: "0xshared",
          slug: market.slug,
          timestamp: 1530,
          side: "SELL",
          outcome: "Down",
          asset: "down-token",
          size: 10,
          usdcSize: 5,
          price: 0.5
        })
      ],
      market,
      1540,
      config
    );

    expect(signal?.wallet).toBe("0xcasewallet00000000000000000000000000000000");
    expect(signal?.side).toBe("BUY");
    expect(signal?.outcome).toBe("Up");
    expect(signal?.asset).toBe("up-token");
    expect(signal?.firstEntrySeconds).toBe(20);
    expect(signal?.latestTradeTimestamp).toBe(1520);
    expect(signal?.liveTradeUsdc).toBe(10.4);
  });

  it("applies strict historical promotion thresholds", () => {
    const summary = candidateSummary({ totalMarkets: 20, totalPnl: 100, winRate: 0.6, oneSidedRate: 0.8 });
    expect(passesStrictHistory(summary)).toBe(true);
    expect(passesStrictHistory(candidateSummary({ totalMarkets: 19, totalPnl: 100, winRate: 0.6, oneSidedRate: 0.8 }))).toBe(false);
    expect(passesStrictHistory(candidateSummary({ totalMarkets: 20, totalPnl: -1, winRate: 0.9, oneSidedRate: 0.9 }))).toBe(false);
    expect(passesStrictHistory(candidateSummary({ totalMarkets: 20, totalPnl: 100, winRate: 0.59, oneSidedRate: 0.9 }))).toBe(false);
    expect(passesStrictHistory(candidateSummary({ totalMarkets: 20, totalPnl: 100, winRate: 0.9, oneSidedRate: 0.79 }))).toBe(false);
  });

  it("suppresses repeat signals inside the cooldown window", () => {
    const key: SignalCooldownKey = { wallet: "0xabc", conditionId: "0xmarket", kind: "entry" };
    const seen = new Map<string, number>();
    expect(shouldSuppressRepeatSignal(key, seen, 1000, config)).toBe(false);
    expect(shouldSuppressRepeatSignal(key, seen, 1100, config)).toBe(true);
    expect(shouldSuppressRepeatSignal(key, seen, 1300, config)).toBe(false);
  });

  it("builds entry and exit tickets with slippage, tick rounding, and balance caps", () => {
    const market: MarketMetadata = {
      conditionId: "0xticket",
      slug: "btc-updown-5m-2000",
      title: "Bitcoin Up or Down",
      marketType: "5m",
      startTimestamp: 2000,
      endTimestamp: 2300,
      outcomes: [{ name: "Up", tokenId: "up-token", price: 0.54 }],
      minTickSize: 0.01,
      negRisk: false
    };

    const entry = buildEntryTicket({
      wallet: "0xcandidate",
      market,
      outcome: "Up",
      asset: "up-token",
      observedPrice: 0.54,
      candidateTradeId: "trade-1",
      now: 2010,
      config
    });

    expect(entry.kind).toBe("entry");
    expect(entry.spendUsdc).toBe(10);
    expect(entry.limitPrice).toBe(0.59);
    expect(entry.size).toBe(10 / 0.59);

    const exit = buildExitTicket({
      wallet: "0xcandidate",
      market,
      outcome: "Up",
      asset: "up-token",
      observedPrice: 0.54,
      requestedShares: 30.123456789,
      availableShares: 12.987654321,
      candidateTradeId: "trade-2",
      now: 2010,
      config
    });

    expect(exit.kind).toBe("exit");
    expect(exit.limitPrice).toBe(0.49);
    expect(exit.size).toBe(12.987654321);

    const coarseTickMarket = { ...market, minTickSize: 0.05 };
    const cappedEntry = buildEntryTicket({
      wallet: "0xcandidate",
      market: coarseTickMarket,
      outcome: "Up",
      asset: "up-token",
      observedPrice: 0.96,
      candidateTradeId: "trade-3",
      now: 2010,
      config
    });
    expect(cappedEntry.limitPrice).toBe(0.95);
    expect(cappedEntry.size).toBe(10 / 0.95);

    const flooredExit = buildExitTicket({
      wallet: "0xcandidate",
      market: coarseTickMarket,
      outcome: "Up",
      asset: "up-token",
      observedPrice: 0.03,
      requestedShares: 12.123456789,
      availableShares: 30.987654321,
      candidateTradeId: "trade-4",
      now: 2010,
      config
    });
    expect(flooredExit.limitPrice).toBe(0.05);
    expect(flooredExit.size).toBe(12.123456789);
  });
});

describe("scanner service", () => {
  const scanMarket: MarketMetadata = {
    conditionId: "0xscan",
    slug: "btc-updown-5m-3000",
    title: "Bitcoin Up or Down",
    marketType: "5m",
    startTimestamp: 3000,
    endTimestamp: 3300,
    outcomes: [{ name: "Up", tokenId: "up-token", price: 0.54 }],
    minTickSize: 0.01,
    negRisk: false
  };

  it("promotes strict live candidates and creates entry tickets", async () => {
    const service = new ScannerService({
      now: () => 3020,
      intervalMs: 60_000,
      client: {
        getShortTermBtcMarkets: async () => [scanMarket],
        getTradesByMarkets: async () => [
          trade({
            proxyWallet: "0x1111111111111111111111111111111111111111",
            conditionId: "0xscan",
            slug: scanMarket.slug,
            title: scanMarket.title,
            timestamp: 3010,
            outcome: "Up",
            asset: "up-token",
            size: 30,
            usdcSize: 16.2,
            price: 0.54
          })
        ],
        getLeaderboardTraders: async () => [],
        getActivityRange: async () => [],
        getGammaMarketBySlug: async () => undefined
      },
      summarizeHistory: async () => candidateSummary({ proxyWallet: "0x1111111111111111111111111111111111111111" })
    });

    await service.scanOnce();
    const snapshot = service.getSnapshot();

    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0].recommendation).toBe("prepare_entry");
    expect(snapshot.tickets).toHaveLength(1);
    expect(snapshot.tickets[0].limitPrice).toBe(0.59);
  });

  it("reuses the in-flight scan for concurrent scanOnce calls", async () => {
    let marketCalls = 0;
    let resolveMarkets: ((markets: MarketMetadata[]) => void) | undefined;
    const marketsReady = new Promise<MarketMetadata[]>((resolve) => {
      resolveMarkets = resolve;
    });
    const service = new ScannerService({
      now: () => 3020,
      client: {
        getShortTermBtcMarkets: async () => {
          marketCalls += 1;
          return marketsReady;
        },
        getTradesByMarkets: async () => [],
        getLeaderboardTraders: async () => [],
        getActivityRange: async () => [],
        getGammaMarketBySlug: async () => undefined
      },
      summarizeHistory: async () => candidateSummary()
    });

    const first = service.scanOnce();
    const second = service.scanOnce();

    expect(marketCalls).toBe(1);
    resolveMarkets?.([scanMarket]);
    await Promise.all([first, second]);
    expect(marketCalls).toBe(1);
  });

  it("does not burn cooldowns for strict-failing signals", async () => {
    let historyCalls = 0;
    const service = new ScannerService({
      now: () => 3020,
      client: scannerClient([scanMarket], [
        trade({
          proxyWallet: "0x1111111111111111111111111111111111111111",
          conditionId: scanMarket.conditionId,
          slug: scanMarket.slug,
          title: scanMarket.title,
          timestamp: 3010,
          outcome: "Up",
          asset: "up-token",
          size: 30,
          usdcSize: 16.2,
          price: 0.54
        })
      ]),
      summarizeHistory: async () => {
        historyCalls += 1;
        return candidateSummary(historyCalls === 1 ? { totalMarkets: 1 } : {});
      }
    });

    await service.scanOnce();
    expect(service.getSnapshot().candidates).toHaveLength(0);

    await service.scanOnce();
    expect(service.getSnapshot().candidates).toHaveLength(1);
    expect(service.getSnapshot().tickets).toHaveLength(1);
  });

  it("loads closed Gamma winners for default history and caches wallet summaries", async () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const secondMarket: MarketMetadata = { ...scanMarket, conditionId: "0xscan2", slug: "btc-updown-5m-3300", startTimestamp: 3300, endTimestamp: 3600 };
    let liveMarket = scanMarket;
    let liveTrades = [
      trade({
        proxyWallet: wallet,
        conditionId: liveMarket.conditionId,
        slug: liveMarket.slug,
        title: liveMarket.title,
        timestamp: liveMarket.startTimestamp + 10,
        outcome: "Up",
        asset: "up-token",
        size: 30,
        usdcSize: 16.2,
        price: 0.54
      })
    ];
    const history = Array.from({ length: 20 }, (_, index) =>
      trade({
        proxyWallet: wallet,
        conditionId: `0xhistory${index}`,
        slug: `btc-updown-5m-${1000 + index * 300}`,
        title: "Bitcoin Up or Down",
        timestamp: 1010 + index * 300,
        outcome: "Up",
        asset: "up-token",
        size: 10,
        usdcSize: 4,
        price: 0.4
      })
    );
    const gammaCalls: string[] = [];
    const service = new ScannerService({
      now: () => 3020,
      client: {
        getShortTermBtcMarkets: async () => [liveMarket],
        getTradesByMarkets: async () => liveTrades,
        getLeaderboardTraders: async () => [],
        getActivityRange: async () => history,
        getGammaMarketBySlug: async (slug) => {
          gammaCalls.push(slug);
          return gammaMarket({
            conditionId: history.find((item) => item.slug === slug)?.conditionId,
            slug,
            closed: true,
            outcomePrices: "[\"1\",\"0\"]"
          });
        }
      }
    });

    await service.scanOnce();
    expect(service.getSnapshot().candidates).toHaveLength(1);
    expect(gammaCalls).toHaveLength(20);

    liveMarket = secondMarket;
    liveTrades = [
      trade({
        proxyWallet: wallet,
        conditionId: liveMarket.conditionId,
        slug: liveMarket.slug,
        title: liveMarket.title,
        timestamp: liveMarket.startTimestamp + 10,
        outcome: "Up",
        asset: "up-token",
        size: 30,
        usdcSize: 16.2,
        price: 0.54
      })
    ];
    await service.scanOnce();
    expect(gammaCalls).toHaveLength(20);
  });

  it("preserves tickets and executions across later empty scans", async () => {
    let trades = [
      trade({
        proxyWallet: "0x1111111111111111111111111111111111111111",
        conditionId: scanMarket.conditionId,
        slug: scanMarket.slug,
        title: scanMarket.title,
        timestamp: 3010,
        outcome: "Up",
        asset: "up-token",
        size: 30,
        usdcSize: 16.2,
        price: 0.54
      })
    ];
    const service = new ScannerService({
      now: () => 3020,
      client: {
        getShortTermBtcMarkets: async () => [scanMarket],
        getTradesByMarkets: async () => trades,
        getLeaderboardTraders: async () => [],
        getActivityRange: async () => [],
        getGammaMarketBySlug: async () => undefined
      },
      summarizeHistory: async () => candidateSummary()
    });

    await service.scanOnce();
    const ticket = service.getSnapshot().tickets[0];
    service.recordExecution({
      id: "execution-1",
      ticketId: ticket.id,
      status: "dry_run",
      message: "recorded",
      createdAt: 3021
    });

    trades = [];
    await service.scanOnce();

    expect(service.getSnapshot().tickets).toContainEqual(ticket);
    expect(service.getSnapshot().executions).toHaveLength(1);
  });
});

function scannerClient(markets: MarketMetadata[], trades: ActivityTrade[]) {
  return {
    getShortTermBtcMarkets: async () => markets,
    getTradesByMarkets: async () => trades,
    getLeaderboardTraders: async () => [],
    getActivityRange: async () => [],
    getGammaMarketBySlug: async () => undefined
  };
}

function candidateSummary(overrides: Partial<CandidateSummary> = {}): CandidateSummary {
  return {
    proxyWallet: "0xcandidate",
    userName: "candidate",
    rank: "1",
    leaderboardPnl: 0,
    leaderboardVol: 0,
    totalMarkets: 20,
    totalTrades: 40,
    wins: 12,
    losses: 8,
    breakeven: 0,
    winRate: 0.6,
    totalPnl: 100,
    totalBuy: 300,
    totalSell: 100,
    settlementValue: 300,
    roi: 0.33,
    earlyEntryRate: 0.9,
    oneSidedRate: 0.8,
    holdThroughRate: 0.7,
    averageFirstEntrySeconds: 40,
    copyabilityScore: 80,
    markets: [],
    ...overrides
  };
}

function gammaMarket(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    question: "Bitcoin Up or Down",
    conditionId: "0xcondition",
    slug: "btc-updown-5m-1779364800",
    endDate: "2026-05-21T12:05:00Z",
    outcomes: "[\"Up\",\"Down\"]",
    outcomePrices: "[\"0.54\",\"0.46\"]",
    closed: false,
    clobTokenIds: "[\"up-token\",\"down-token\"]",
    orderPriceMinTickSize: 0.01,
    active: true,
    acceptingOrders: true,
    ...overrides
  };
}

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
