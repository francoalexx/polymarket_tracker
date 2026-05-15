export const DEFAULT_WALLET = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30";
export const YWS1_WALLET = "0x3a9fb46bcbd2982559fe683f4bc3748ec265ea97";
export const DEFAULT_TRACKED_WALLETS = [DEFAULT_WALLET, YWS1_WALLET];

export type PositionLeg = {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventId: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
};

export type ActivityTrade = {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: "BUY" | "SELL" | string;
  outcomeIndex: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  name?: string;
  pseudonym?: string;
};

export type LeaderboardTrader = {
  rank: string;
  proxyWallet: string;
  userName?: string;
  vol: number;
  pnl: number;
  profileImage?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
};

export type GammaMarket = {
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  outcomes: string;
  outcomePrices: string;
  closed: boolean;
  umaResolutionStatus?: string;
};

export type GammaEvent = {
  slug: string;
  title: string;
  markets?: GammaMarket[];
};

export type GroupedPosition = {
  conditionId: string;
  title: string;
  slug: string;
  icon: string;
  eventId: string;
  eventSlug: string;
  endDate: string;
  legs: PositionLeg[];
  totalCurrentValue: number;
  totalInitialValue: number;
  totalCashPnl: number;
  totalShares: number;
  netSharesByOutcome: Record<string, number>;
  dominantOutcome: string;
  isShortTermCrypto: boolean;
  lastTradeTimestamp?: number;
};

export type PositionsSnapshot = {
  wallet: string;
  receivedAt: number;
  groups: GroupedPosition[];
  rawCount: number;
};

export type PriceUpdate = {
  asset: string;
  price?: number;
  bid?: number;
  ask?: number;
  receivedAt: number;
  source: "websocket" | "positions";
};

export type StatusPayload = {
  status: "connecting" | "live" | "stale" | "reconnecting" | "closed";
  message: string;
  receivedAt: number;
};

export type ErrorPayload = {
  message: string;
  receivedAt: number;
};
