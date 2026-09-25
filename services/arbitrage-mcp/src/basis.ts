import type { ReferencePrice } from "./markets.js";

export interface BasisReading {
  baseSymbol: string;
  comparisonSymbol: string;
  basisBps: number;
}

export function calculateBasis(
  base: ReferencePrice,
  comparison: ReferencePrice,
): BasisReading {
  if (base.priceUsd <= 0 || comparison.priceUsd <= 0) {
    throw new Error("Prices must be positive");
  }

  return {
    baseSymbol: base.symbol,
    comparisonSymbol: comparison.symbol,
    basisBps: ((comparison.priceUsd - base.priceUsd) / base.priceUsd) * 10_000,
  };
}

export function isFresh(price: ReferencePrice, nowMs: number, maximumAgeMs: number): boolean {
  const ageMs = nowMs - price.feedUpdatedAtMs;
  return ageMs >= 0 && ageMs <= maximumAgeMs;
}
