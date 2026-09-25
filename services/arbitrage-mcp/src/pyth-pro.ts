import { AAPL_FEED_IDS, AAPL_MARKETS, type AaplMarketSymbol, type ReferencePrice } from "./markets.js";

export const AAPL_SYMBOLS = Object.values(AAPL_MARKETS) as AaplMarketSymbol[];
const PYTH_PRO_REST_URL = "https://pyth-lazer.dourolabs.app/v1/latest_price";
const SESSIONS = new Set(["regular", "preMarket", "postMarket", "overNight", "closed"]);

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Pyth ${label}`);
  return value as JsonObject;
}

function integer(value: unknown, label: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`Invalid Pyth ${label}`);
  if ((typeof value !== "string" && typeof value !== "number") || !/^-?\d+$/.test(String(value))) {
    throw new Error(`Invalid Pyth ${label}`);
  }
  return BigInt(value);
}

function timestampMs(value: unknown, label: string): number {
  const microseconds = integer(value, label);
  const milliseconds = Number(microseconds / 1_000n);
  if (microseconds <= 0n || !Number.isSafeInteger(milliseconds)) throw new Error(`Invalid Pyth ${label}`);
  return milliseconds;
}

function scaledPrice(mantissa: bigint, exponent: number, label: string): number {
  if (!Number.isInteger(exponent) || exponent < -18 || exponent > 18) throw new Error(`Invalid Pyth ${label} exponent`);
  const digits = (mantissa < 0n ? -mantissa : mantissa).toString();
  const sign = mantissa < 0n ? "-" : "";
  const decimal = exponent >= 0
    ? `${sign}${digits}${"0".repeat(exponent)}`
    : `${sign}${digits.padStart(-exponent + 1, "0").slice(0, exponent)}.${digits.padStart(-exponent + 1, "0").slice(exponent)}`;
  const result = Number(decimal);
  if (!Number.isFinite(result)) throw new Error(`Invalid Pyth ${label}`);
  return result;
}

/** Decode one Pyth Pro latest-price response requested for exactly one symbol. */
export function parsePythLatest(symbol: AaplMarketSymbol, payload: unknown): ReferencePrice {
  const envelope = object(payload, "response");
  const parsed = object(envelope.parsed, "parsed payload");
  const feeds = parsed.priceFeeds;
  if (!Array.isArray(feeds) || feeds.length !== 1) throw new Error(`Pyth returned ${Array.isArray(feeds) ? feeds.length : "no"} feeds for ${symbol}`);
  const feed = object(feeds[0], "feed");
  const priceMantissa = integer(feed.price, "price");
  const confidenceMantissa = integer(feed.confidence, "confidence");
  const exponent = Number(integer(feed.exponent, "exponent"));
  const priceUsd = scaledPrice(priceMantissa, exponent, "price");
  const confidenceUsd = scaledPrice(confidenceMantissa, exponent, "confidence");
  if (priceUsd <= 0 || confidenceUsd < 0) throw new Error(`Invalid Pyth price or confidence for ${symbol}`);
  const feedId = Number(integer(feed.priceFeedId, "feed ID"));
  const publisherCount = Number(integer(feed.publisherCount, "publisher count"));
  if (!Number.isSafeInteger(feedId) || feedId < 0 || !Number.isSafeInteger(publisherCount) || publisherCount < 0) {
    throw new Error(`Invalid Pyth feed metadata for ${symbol}`);
  }
  if (feedId !== AAPL_FEED_IDS[symbol]) throw new Error(`Unexpected Pyth feed ID for ${symbol}: ${feedId}`);
  if (typeof feed.marketSession !== "string" || !SESSIONS.has(feed.marketSession)) {
    throw new Error(`Invalid Pyth market session for ${symbol}`);
  }
  return {
    symbol,
    feedId,
    priceUsd,
    confidenceUsd,
    priceMantissa: priceMantissa.toString(),
    confidenceMantissa: confidenceMantissa.toString(),
    exponent,
    observedAtMs: timestampMs(parsed.timestampUs, "stream timestamp"),
    feedUpdatedAtMs: timestampMs(feed.feedUpdateTimestamp, "feed update timestamp"),
    marketSession: feed.marketSession as ReferencePrice["marketSession"],
    publisherCount,
  };
}

export class PythProMarketClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly endpoint = PYTH_PRO_REST_URL,
  ) {
    if (!accessToken) throw new Error("PYTH_PRO_ACCESS_TOKEN is required");
  }

  async fetchLatest(symbol: AaplMarketSymbol): Promise<ReferencePrice> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        symbols: [symbol],
        properties: ["price", "confidence", "exponent", "marketSession", "publisherCount", "feedUpdateTimestamp"],
        formats: [],
        parsed: true,
        channel: "fixed_rate@1000ms",
        ignoreInvalidFeeds: false,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const code = response.status === 403 ? "PYTH_FEED_NOT_ENTITLED" : response.status === 401 ? "PYTH_AUTH_REJECTED" : response.status === 429 ? "PYTH_RATE_LIMITED" : "PYTH_UPSTREAM_UNAVAILABLE";
      throw new Error(code);
    }
    return parsePythLatest(symbol, await response.json());
  }
}
