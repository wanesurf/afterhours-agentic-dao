export const AAPL_MARKETS = {
  equity: "Equity.US.AAPL/USD",
  xStocks: "Crypto.AAPLX/USD",
  ondo: "Crypto.AAPLON/USD",
} as const;

export type AaplMarketSymbol = (typeof AAPL_MARKETS)[keyof typeof AAPL_MARKETS];

// Pyth Pro feed IDs, verified against the public /v1/symbols catalog.
export const AAPL_FEED_IDS: Record<AaplMarketSymbol, number> = {
  [AAPL_MARKETS.equity]: 922,
  [AAPL_MARKETS.xStocks]: 1792,
  [AAPL_MARKETS.ondo]: 3132,
};

export interface ReferencePrice {
  symbol: AaplMarketSymbol;
  feedId: number;
  priceUsd: number;
  confidenceUsd: number;
  priceMantissa: string;
  confidenceMantissa: string;
  exponent: number;
  observedAtMs: number;
  feedUpdatedAtMs: number;
  marketSession: "regular" | "preMarket" | "postMarket" | "overNight" | "closed";
  publisherCount: number;
}

export interface ExecutableQuote {
  symbol: AaplMarketSymbol;
  venue: string;
  side: "buy" | "sell";
  amount: number;
  priceUsd: number;
  feeUsd: number;
  estimatedSlippageUsd: number;
  expiresAtMs: number;
}
