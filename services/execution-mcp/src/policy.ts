export interface StrategyMandate {
  id: string;
  activeFromMs: number;
  expiresAtMs: number;
  allowedSymbols: string[];
  allowedVenues: string[];
  maximumTradeUsd: number;
  maximumStrategyExposureUsd: number;
  maximumSlippageBps: number;
  minimumNetProfitBps: number;
  maximumQuoteAgeMs: number;
  emergencyPaused: boolean;
}

export interface ProposedTrade {
  symbol: string;
  venue: string;
  notionalUsd: number;
  estimatedSlippageBps: number;
  expectedNetProfitBps: number;
  quotedAtMs: number;
  quoteExpiresAtMs: number;
}

/** Read from the vault and open orders, never supplied by Hermes or a tool caller. */
export interface StrategyState {
  exposureUsd: number;
}

const MAXIMUM_ACCEPTED_QUOTE_AGE_MS = 10_000;

function nonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function validateTrade(
  mandate: StrategyMandate,
  trade: ProposedTrade,
  state: StrategyState,
  nowMs: number,
): string[] {
  const failures: string[] = [];

  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return ["invalid current time"];
  if (!Number.isSafeInteger(mandate.activeFromMs) ||
      !Number.isSafeInteger(mandate.expiresAtMs) ||
      mandate.activeFromMs >= mandate.expiresAtMs ||
      !Number.isSafeInteger(mandate.maximumQuoteAgeMs) ||
      mandate.maximumQuoteAgeMs <= 0 ||
      mandate.maximumQuoteAgeMs > MAXIMUM_ACCEPTED_QUOTE_AGE_MS ||
      !nonNegativeFinite(mandate.maximumTradeUsd) ||
      !nonNegativeFinite(mandate.maximumStrategyExposureUsd) ||
      !nonNegativeFinite(mandate.maximumSlippageBps) ||
      !nonNegativeFinite(mandate.minimumNetProfitBps)) {
    failures.push("invalid mandate limits");
  }
  if (mandate.emergencyPaused) failures.push("strategy is paused");
  if (nowMs < mandate.activeFromMs || nowMs >= mandate.expiresAtMs) failures.push("mandate is inactive");
  if (!mandate.allowedSymbols.includes(trade.symbol)) failures.push("symbol is not approved");
  if (!mandate.allowedVenues.includes(trade.venue)) failures.push("venue is not approved");
  if (!Number.isFinite(trade.notionalUsd) || trade.notionalUsd <= 0) failures.push("invalid trade size");
  if (!nonNegativeFinite(state.exposureUsd)) failures.push("invalid vault exposure");
  if (!nonNegativeFinite(trade.estimatedSlippageBps)) failures.push("invalid slippage estimate");
  if (!Number.isFinite(trade.expectedNetProfitBps)) failures.push("invalid expected profit");
  if (!Number.isSafeInteger(trade.quotedAtMs) || !Number.isSafeInteger(trade.quoteExpiresAtMs) ||
      trade.quoteExpiresAtMs <= trade.quotedAtMs || trade.quotedAtMs > nowMs ||
      nowMs - trade.quotedAtMs > mandate.maximumQuoteAgeMs || nowMs >= trade.quoteExpiresAtMs) {
    failures.push("quote is stale or invalid");
  }
  if (trade.notionalUsd > mandate.maximumTradeUsd) failures.push("trade exceeds maximum size");
  if (state.exposureUsd + trade.notionalUsd > mandate.maximumStrategyExposureUsd) failures.push("strategy exposure exceeds limit");
  if (trade.estimatedSlippageBps > mandate.maximumSlippageBps) failures.push("slippage exceeds limit");
  if (trade.expectedNetProfitBps < mandate.minimumNetProfitBps) failures.push("expected profit is below threshold");

  return failures;
}
