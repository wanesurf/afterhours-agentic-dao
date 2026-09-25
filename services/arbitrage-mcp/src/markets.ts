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

export const TRIAL_MARKETS = {
  bitcoin: "Crypto.BTC/USD",
  wrappedBitcoin: "Crypto.WBTC/USD",
  tesla: "Equity.US.TSLA/USD",
  sp500: "Equity.US.VOO/USD",
  nasdaq: "Equity.US.QQQ/USD",
} as const;

export type MarketSymbol = AaplMarketSymbol | (typeof TRIAL_MARKETS)[keyof typeof TRIAL_MARKETS];
export const FEED_IDS: Record<MarketSymbol, number> = {
  ...AAPL_FEED_IDS,
  [TRIAL_MARKETS.bitcoin]: 1,
  [TRIAL_MARKETS.wrappedBitcoin]: 103,
  [TRIAL_MARKETS.tesla]: 1435,
  [TRIAL_MARKETS.sp500]: 1472,
  [TRIAL_MARKETS.nasdaq]: 1363,
};

export interface MarketProfile {
  id: "apple" | "free-trial";
  title: string;
  description: string;
  note: string;
  symbols: readonly MarketSymbol[];
  basisPairs: readonly (readonly [MarketSymbol, MarketSymbol])[];
  convergencePairs: readonly (readonly [MarketSymbol, MarketSymbol])[];
}

export const APPLE_PROFILE: MarketProfile = {
  id: "apple",
  title: "One stock. Three prices.",
  description: "Compare Apple equity with its xStocks and Ondo representations.",
  note: "Apple feeds require additional Pyth access. Price gaps require executable venue quotes and an approved mandate before any trade.",
  symbols: Object.values(AAPL_MARKETS),
  basisPairs: [[AAPL_MARKETS.equity, AAPL_MARKETS.xStocks], [AAPL_MARKETS.equity, AAPL_MARKETS.ondo], [AAPL_MARKETS.xStocks, AAPL_MARKETS.ondo]],
  convergencePairs: [[AAPL_MARKETS.equity, AAPL_MARKETS.xStocks], [AAPL_MARKETS.equity, AAPL_MARKETS.ondo]],
};

export const TRIAL_PROFILE: MarketProfile = {
  id: "free-trial",
  title: "Five feeds. One reference pair.",
  description: "Watch Bitcoin against wrapped Bitcoin, with Tesla, VOO, and QQQ as equity market context.",
  note: "Pyth trial feeds: BTC/WBTC is an indicative reference spread. TSLA, VOO, and QQQ are observation only. Apple equity, xStocks, and Ondo comparisons await feed access. WBTC carries custody and redemption risks; no executable Solana venue or arbitrage is established by this comparison.",
  symbols: Object.values(TRIAL_MARKETS),
  basisPairs: [[TRIAL_MARKETS.bitcoin, TRIAL_MARKETS.wrappedBitcoin]],
  convergencePairs: [[TRIAL_MARKETS.bitcoin, TRIAL_MARKETS.wrappedBitcoin]],
};

export function selectMarketProfile(value = "free-trial"): MarketProfile {
  if (value === "free-trial") return TRIAL_PROFILE;
  if (value === "apple") return APPLE_PROFILE;
  throw new Error("PYTH_MARKET_PROFILE must be free-trial or apple");
}

export interface ReferencePrice {
  symbol: MarketSymbol;
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
  symbol: MarketSymbol;
  venue: string;
  side: "buy" | "sell";
  amount: number;
  priceUsd: number;
  feeUsd: number;
  estimatedSlippageUsd: number;
  expiresAtMs: number;
}
