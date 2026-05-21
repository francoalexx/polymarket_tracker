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
  clobTokenIds?: string;
  orderPriceMinTickSize?: number | string;
  negRisk?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  startDate?: string;
  eventStartTime?: string;
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
  isPending: boolean;
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

export type MarketType = "5m" | "15m";

export type CopyTraderConfig = {
  primaryMarketType: MarketType;
  fallbackMarketType: MarketType;
  latencyThresholdSeconds: number;
  activeWithinSeconds: number;
  earlyEntrySeconds: number;
  minLiveTradeUsdc: number;
  maxEntryPrice: number;
  repeatCooldownSeconds: number;
  defaultEntrySpendUsdc: number;
  maxSlippageCents: number;
};

export type MarketOutcomeMetadata = {
  name: string;
  tokenId: string;
  price?: number;
};

export type MarketMetadata = {
  conditionId: string;
  slug: string;
  title: string;
  marketType: MarketType;
  startTimestamp: number;
  endTimestamp: number;
  outcomes: MarketOutcomeMetadata[];
  minTickSize: number;
  negRisk: boolean;
};

export type SignalRecommendation = "watch" | "prepare_entry" | "prepare_exit" | "latency_degraded";
export type SignalSource = "leaderboard" | "live" | "both";

export type LiveWalletSignal = {
  wallet: string;
  name?: string;
  source: SignalSource;
  market: MarketMetadata;
  outcome: string;
  asset: string;
  side: "BUY" | "SELL";
  firstEntrySeconds: number;
  latestTradeTimestamp: number;
  latestTradeAgeSeconds: number;
  detectedAt: number;
  latencySeconds: number;
  isOneSided: boolean;
  liveTradeUsdc: number;
  observedPrice: number;
  recommendation: SignalRecommendation;
  candidateTradeId: string;
  reason: string;
};

export type LatencySample = {
  source?: string;
  marketType?: MarketType;
  latencySeconds: number;
  tradeTimestamp?: number;
  receivedAt?: number;
};

export type LatencyMode = {
  activeMarketType: MarketType;
  isDegraded: boolean;
  medianLatencySeconds: number;
};

export type SignalCooldownKey = {
  wallet: string;
  conditionId: string;
  kind: "entry" | "exit";
};

export type PreparedTradeTicket = {
  id: string;
  kind: "entry" | "exit";
  status: "pending" | "confirmed" | "submitted" | "cancelled" | "rejected";
  wallet: string;
  market: MarketMetadata;
  outcome: string;
  asset: string;
  observedPrice: number;
  limitPrice: number;
  size: number;
  spendUsdc?: number;
  availableShares?: number;
  candidateTradeId: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
};

export type CandidateFeedItem = {
  wallet: string;
  name?: string;
  source: SignalSource;
  marketType: MarketType;
  outcome: string;
  recommendation: SignalRecommendation;
  score: number;
  lastTradeAgeSeconds: number;
  latencySeconds: number;
  strictPass: boolean;
  reason: string;
  signal: LiveWalletSignal;
};

export type ExecutionLogEntry = {
  id: string;
  ticketId: string;
  status: "dry_run" | "submitted" | "rejected" | "error";
  message: string;
  response?: unknown;
  createdAt: number;
};

export type ScannerSnapshot = {
  status: "starting" | "live" | "stale" | "error";
  message: string;
  receivedAt: number;
  latency: LatencyMode;
  candidates: CandidateFeedItem[];
  tickets: PreparedTradeTicket[];
  executions: ExecutionLogEntry[];
};
