import type { ExecutableQuote } from "./markets.js";

export interface EdgeCosts {
  transactionCostUsd: number;
  safetyBufferUsd: number;
}

export interface NetEdge {
  grossProfitUsd: number;
  netProfitUsd: number;
  netEdgeBps: number;
}

export function calculateNetEdge(
  buy: ExecutableQuote,
  sell: ExecutableQuote,
  costs: EdgeCosts,
): NetEdge {
  if (buy.side !== "buy" || sell.side !== "sell") {
    throw new Error("Expected one buy quote and one sell quote");
  }
  if (buy.amount !== sell.amount || buy.amount <= 0) {
    throw new Error("Quotes must have the same positive amount");
  }

  const buyNotional = buy.amount * buy.priceUsd;
  const sellNotional = sell.amount * sell.priceUsd;
  const grossProfitUsd = sellNotional - buyNotional;
  const totalCosts =
    buy.feeUsd +
    sell.feeUsd +
    buy.estimatedSlippageUsd +
    sell.estimatedSlippageUsd +
    costs.transactionCostUsd +
    costs.safetyBufferUsd;
  const netProfitUsd = grossProfitUsd - totalCosts;
  const netEdgeBps = buyNotional === 0 ? 0 : (netProfitUsd / buyNotional) * 10_000;

  return { grossProfitUsd, netProfitUsd, netEdgeBps };
}
