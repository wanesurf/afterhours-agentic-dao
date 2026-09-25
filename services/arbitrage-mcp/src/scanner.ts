import { calculateBasis, isFresh, type BasisReading } from "./basis.js";
import { AAPL_MARKETS, type AaplMarketSymbol, type ReferencePrice } from "./markets.js";
import { AAPL_SYMBOLS, type PythProMarketClient } from "./pyth-pro.js";

export interface ScannerLimits {
  maximumPriceAgeMs: number;
  maximumConfidenceBps: number;
  minimumPublishers: number;
}

export const DEFAULT_SCANNER_LIMITS: ScannerLimits = {
  maximumPriceAgeMs: 10_000,
  maximumConfidenceBps: 50,
  minimumPublishers: 1,
};

export interface MarketReading {
  symbol: AaplMarketSymbol;
  price: ReferencePrice | null;
  confidenceBps: number | null;
  fresh: boolean;
  issues: string[];
}

export interface MarketState {
  observedAtMs: number;
  markets: MarketReading[];
  basis: BasisReading[];
}

export interface ConvergenceSignal {
  buySymbol: AaplMarketSymbol;
  referenceSymbol: AaplMarketSymbol;
  discountBps: number;
  classification: "price-dislocation";
  actionable: false;
  issues: string[];
  evidence: { buyFeedId: number; referenceFeedId: number; buyFeedUpdatedAtMs: number; referenceFeedUpdatedAtMs: number };
}

export interface OpportunityScan {
  marketState: MarketState;
  signals: ConvergenceSignal[];
  executionAvailable: false;
  note: string;
}

function assess(symbol: AaplMarketSymbol, price: ReferencePrice | null, nowMs: number, limits: ScannerLimits, error?: string): MarketReading {
  if (!price) return { symbol, price: null, confidenceBps: null, fresh: false, issues: [error || "FEED_UNAVAILABLE"] };
  const issues: string[] = [];
  const confidenceBps = price.confidenceUsd / price.priceUsd * 10_000;
  const fresh = isFresh(price, nowMs, limits.maximumPriceAgeMs);
  if (!fresh) issues.push("STALE_OR_FUTURE_FEED_UPDATE");
  if (price.observedAtMs > nowMs || nowMs - price.observedAtMs > limits.maximumPriceAgeMs) issues.push("STALE_OR_FUTURE_RESPONSE");
  if (confidenceBps > limits.maximumConfidenceBps) issues.push("EXCESSIVE_CONFIDENCE_INTERVAL");
  if (price.publisherCount < limits.minimumPublishers) issues.push("INSUFFICIENT_PUBLISHERS");
  if (symbol === AAPL_MARKETS.equity && price.marketSession !== "regular") issues.push("EQUITY_MARKET_NOT_REGULAR");
  return { symbol, price, confidenceBps, fresh, issues };
}

export function analyzePrices(
  prices: Partial<Record<AaplMarketSymbol, ReferencePrice>>,
  nowMs: number,
  limits: ScannerLimits = DEFAULT_SCANNER_LIMITS,
  errors: Partial<Record<AaplMarketSymbol, string>> = {},
): MarketState {
  const markets = AAPL_SYMBOLS.map(symbol => assess(symbol, prices[symbol] || null, nowMs, limits, errors[symbol]));
  const available = new Map(markets.filter(row => row.price).map(row => [row.symbol, row.price!]));
  const basis: BasisReading[] = [];
  for (const [base, comparison] of [
    [AAPL_MARKETS.equity, AAPL_MARKETS.xStocks],
    [AAPL_MARKETS.equity, AAPL_MARKETS.ondo],
    [AAPL_MARKETS.xStocks, AAPL_MARKETS.ondo],
  ] as const) {
    const basePrice = available.get(base);
    const comparisonPrice = available.get(comparison);
    if (basePrice && comparisonPrice) basis.push(calculateBasis(basePrice, comparisonPrice));
  }
  return { observedAtMs: nowMs, markets, basis };
}

export function scanConvergence(state: MarketState, minimumDiscountBps: number): OpportunityScan {
  if (!Number.isFinite(minimumDiscountBps) || minimumDiscountBps < 0) throw new Error("Minimum discount must be non-negative");
  const equity = state.markets.find(row => row.symbol === AAPL_MARKETS.equity)!;
  const signals: ConvergenceSignal[] = [];
  for (const symbol of [AAPL_MARKETS.xStocks, AAPL_MARKETS.ondo] as const) {
    const token = state.markets.find(row => row.symbol === symbol)!;
    if (!equity.price || !token.price) continue;
    const discountBps = (equity.price.priceUsd - token.price.priceUsd) / equity.price.priceUsd * 10_000;
    if (discountBps < minimumDiscountBps) continue;
    signals.push({
      buySymbol: symbol,
      referenceSymbol: AAPL_MARKETS.equity,
      discountBps,
      classification: "price-dislocation",
      actionable: false,
      issues: [...equity.issues, ...token.issues, "EXECUTABLE_VENUE_QUOTES_REQUIRED", "CONVERGENCE_NOT_GUARANTEED"],
      evidence: { buyFeedId: token.price.feedId, referenceFeedId: equity.price.feedId,
        buyFeedUpdatedAtMs: token.price.feedUpdatedAtMs, referenceFeedUpdatedAtMs: equity.price.feedUpdatedAtMs },
    });
  }
  return { marketState: state, signals, executionAvailable: false,
    note: "Pyth identifies possible dislocations. No trade is authorized until fresh venue quotes, risk checks, and a DAO mandate are verified." };
}

export async function readMarketState(client: Pick<PythProMarketClient, "fetchLatest">): Promise<MarketState> {
  const settled = await Promise.allSettled(AAPL_SYMBOLS.map(symbol => client.fetchLatest(symbol)));
  const prices: Partial<Record<AaplMarketSymbol, ReferencePrice>> = {};
  const errors: Partial<Record<AaplMarketSymbol, string>> = {};
  settled.forEach((result, index) => {
    const symbol = AAPL_SYMBOLS[index]!;
    if (result.status === "fulfilled") prices[symbol] = result.value;
    else {
      const message = result.reason instanceof Error ? result.reason.message : "";
      errors[symbol] = ["PYTH_FEED_NOT_ENTITLED", "PYTH_AUTH_REJECTED", "PYTH_RATE_LIMITED", "PYTH_UPSTREAM_UNAVAILABLE"].includes(message) ? message : "FEED_UNAVAILABLE";
    }
  });
  return analyzePrices(prices, Date.now(), DEFAULT_SCANNER_LIMITS, errors);
}
