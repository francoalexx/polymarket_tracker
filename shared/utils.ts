import type { GammaMarket } from "./types";

export function readJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getWinningOutcome(market: Pick<GammaMarket, "closed" | "outcomes" | "outcomePrices">): string | undefined {
  if (!market.closed) return undefined;

  const outcomes = readJsonArray(market.outcomes).map(String);
  const prices = readJsonArray(market.outcomePrices).map((price) => Number(price));
  if (outcomes.length === 0 || outcomes.length !== prices.length) return undefined;

  const maxPrice = Math.max(...prices);
  if (!Number.isFinite(maxPrice) || maxPrice < 0.99) return undefined;

  const winningIndex = prices.findIndex((price) => price === maxPrice);
  return outcomes[winningIndex];
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    })
  );

  return results;
}
