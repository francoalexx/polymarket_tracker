import type { ActivityTrade, GroupedPosition, PositionLeg } from "./types";

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const SHORT_TERM_RE = /\b(5|15)\s*(m|min|minute)s?\b|-(5m|15m)-/i;
const CRYPTO_RE = /\b(bitcoin|btc|ethereum|eth|solana|sol)\b/i;

export function isValidWallet(value: string): boolean {
  return WALLET_RE.test(value.trim());
}

export function normalizeWallet(value: string): string {
  return value.trim().toLowerCase();
}

export function getActivityId(trade: ActivityTrade): string {
  return [
    trade.transactionHash,
    trade.asset,
    trade.side,
    Number(trade.price).toFixed(8),
    Number(trade.size).toFixed(8),
    trade.timestamp
  ].join(":");
}

export function isShortTermCryptoMarket(position: Pick<PositionLeg, "title" | "slug">): boolean {
  const haystack = `${position.title} ${position.slug}`;
  return CRYPTO_RE.test(haystack) && SHORT_TERM_RE.test(haystack);
}

export function groupPositions(positions: PositionLeg[], activity: ActivityTrade[] = []): GroupedPosition[] {
  const latestActivityByCondition = new Map<string, number>();

  for (const trade of activity) {
    const current = latestActivityByCondition.get(trade.conditionId) ?? 0;
    if (trade.timestamp > current) latestActivityByCondition.set(trade.conditionId, trade.timestamp);
  }

  const grouped = new Map<string, PositionLeg[]>();
  for (const position of positions) {
    const existing = grouped.get(position.conditionId) ?? [];
    existing.push(position);
    grouped.set(position.conditionId, existing);
  }

  return Array.from(grouped.entries())
    .map(([conditionId, legs]) => {
      const [first] = legs;
      const netSharesByOutcome = legs.reduce<Record<string, number>>((acc, leg) => {
        acc[leg.outcome] = (acc[leg.outcome] ?? 0) + Number(leg.size || 0);
        return acc;
      }, {});
      const dominantOutcome =
        Object.entries(netSharesByOutcome).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] ?? "N/A";

      return {
        conditionId,
        title: first.title,
        slug: first.slug,
        icon: first.icon,
        eventId: first.eventId,
        eventSlug: first.eventSlug,
        endDate: first.endDate,
        legs: [...legs].sort((a, b) => a.outcomeIndex - b.outcomeIndex),
        totalCurrentValue: sum(legs, "currentValue"),
        totalInitialValue: sum(legs, "initialValue"),
        totalCashPnl: sum(legs, "cashPnl"),
        totalShares: sum(legs, "size"),
        netSharesByOutcome,
        dominantOutcome,
        isShortTermCrypto: legs.some(isShortTermCryptoMarket),
        lastTradeTimestamp: latestActivityByCondition.get(conditionId)
      };
    })
    .sort((a, b) => {
      if (a.isShortTermCrypto !== b.isShortTermCrypto) return a.isShortTermCrypto ? -1 : 1;
      return b.totalCurrentValue - a.totalCurrentValue;
    });
}

function sum<T extends Record<string, unknown>>(items: T[], key: keyof T): number {
  return roundMoney(items.reduce((total, item) => total + Number(item[key] || 0), 0));
}

function roundMoney(value: number): number {
  return Math.round(value * 10000) / 10000;
}
