import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AAPL_FEED_IDS, AAPL_MARKETS, FEED_IDS, TRIAL_MARKETS, TRIAL_PROFILE, selectMarketProfile, type MarketSymbol, type ReferencePrice } from "../services/arbitrage-mcp/src/markets.js";
import { parsePythLatest, PythProMarketClient } from "../services/arbitrage-mcp/src/pyth-pro.js";
import { analyzePrices, scanConvergence, readMarketState } from "../services/arbitrage-mcp/src/scanner.js";
import { createArbitrageMcpHttpServer } from "../services/arbitrage-mcp/src/server.js";

const now = 1_790_000_000_000;

function pythPayload(price: string, feedUpdateTimestamp = now * 1_000, feedId = AAPL_FEED_IDS[AAPL_MARKETS.equity]) {
  return { type: "streamUpdated", parsed: { timestampUs: String(now * 1_000), priceFeeds: [{
    priceFeedId: feedId, price, confidence: "250", exponent: -5, publisherCount: 4,
    marketSession: "regular", feedUpdateTimestamp,
  }] } };
}

function price(symbol: MarketSymbol, priceUsd: number, overrides: Partial<ReferencePrice> = {}): ReferencePrice {
  return { symbol, feedId: 42, priceUsd, confidenceUsd: 0.0025,
    priceMantissa: String(priceUsd * 100_000), confidenceMantissa: "250", exponent: -5,
    observedAtMs: now, feedUpdatedAtMs: now, marketSession: "regular", publisherCount: 4, ...overrides };
}

test("normalizes Pyth Pro mantissa and uses feed update time, not the stream timestamp", () => {
  const result = parsePythLatest(AAPL_MARKETS.equity, pythPayload("20000000", (now - 60_000) * 1_000));
  assert.equal(result.priceUsd, 200);
  assert.equal(result.confidenceUsd, 0.0025);
  assert.equal(result.observedAtMs, now);
  assert.equal(result.feedUpdatedAtMs, now - 60_000);
  assert.throws(() => parsePythLatest(AAPL_MARKETS.equity, pythPayload("0")), /Invalid Pyth price/);
  assert.throws(() => parsePythLatest(AAPL_MARKETS.equity, pythPayload("20000000", now * 1_000, AAPL_FEED_IDS[AAPL_MARKETS.xStocks])), /Unexpected Pyth feed ID/);
});

test("Pyth client requests a single named feed with a server-side bearer key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return Response.json(pythPayload("20000000", now * 1_000, AAPL_FEED_IDS[AAPL_MARKETS.xStocks]));
  };
  const client = new PythProMarketClient("test-key", fetcher);
  const result = await client.fetchLatest(AAPL_MARKETS.xStocks);
  assert.equal(result.symbol, AAPL_MARKETS.xStocks);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)).symbols, [AAPL_MARKETS.xStocks]);
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer test-key");
});

test("scanner exposes all three basis readings but never marks feed-only gaps executable", () => {
  const state = analyzePrices({
    [AAPL_MARKETS.equity]: price(AAPL_MARKETS.equity, 200),
    [AAPL_MARKETS.xStocks]: price(AAPL_MARKETS.xStocks, 195),
    [AAPL_MARKETS.ondo]: price(AAPL_MARKETS.ondo, 198),
  }, now);
  assert.equal(state.basis.length, 3);
  const scan = scanConvergence(state, 50);
  assert.equal(scan.signals.length, 2);
  assert.equal(scan.signals[0]!.buySymbol, AAPL_MARKETS.xStocks);
  assert.equal(scan.signals[0]!.discountBps, 250);
  assert.equal(scan.signals[0]!.actionable, false);
  assert.ok(scan.signals[0]!.issues.includes("EXECUTABLE_VENUE_QUOTES_REQUIRED"));
});

test("carried-forward equity and closed session are reported as unsuitable for live execution", () => {
  const state = analyzePrices({
    [AAPL_MARKETS.equity]: price(AAPL_MARKETS.equity, 200, { feedUpdatedAtMs: now - 60_000, marketSession: "closed" }),
    [AAPL_MARKETS.xStocks]: price(AAPL_MARKETS.xStocks, 190),
  }, now);
  const equity = state.markets[0]!;
  assert.equal(equity.fresh, false);
  assert.ok(equity.issues.includes("STALE_OR_FUTURE_FEED_UPDATE"));
  assert.ok(equity.issues.includes("EQUITY_MARKET_NOT_REGULAR"));
  const scan = scanConvergence(state, 50);
  assert.ok(scan.signals[0]!.issues.includes("STALE_OR_FUTURE_FEED_UPDATE"));
});

test("MCP exposes only read-only market and scan tools behind a bearer token", async () => {
  const state = analyzePrices({
    [AAPL_MARKETS.equity]: price(AAPL_MARKETS.equity, 200),
    [AAPL_MARKETS.xStocks]: price(AAPL_MARKETS.xStocks, 195),
    [AAPL_MARKETS.ondo]: price(AAPL_MARKETS.ondo, 198),
  }, now);
  const server = createArbitrageMcpHttpServer({ read: async () => state }, "secret");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  try {
    const unauthorized = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const client = new Client({ name: "afterhours-test", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer secret" } } }));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["get_market_state", "scan_opportunities"]);
    const scan = await client.callTool({ name: "scan_opportunities", arguments: { minimumDiscountBps: 50 } });
    assert.equal(scan.isError, undefined);
    const content = (scan.content as Array<{ type: string; text?: string }>)[0];
    assert.equal(content?.type, "text");
    if (content?.type === "text") assert.equal(JSON.parse(content.text || "{}").signals.length, 2);
    await client.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


test("trial scanner compares only BTC/WBTC and checks equity sessions independently", () => {
  const state = analyzePrices({
    [TRIAL_MARKETS.bitcoin]: price(TRIAL_MARKETS.bitcoin, 80_000),
    [TRIAL_MARKETS.wrappedBitcoin]: price(TRIAL_MARKETS.wrappedBitcoin, 79_000),
    [TRIAL_MARKETS.tesla]: price(TRIAL_MARKETS.tesla, 300, { marketSession: "closed" }),
    [TRIAL_MARKETS.sp500]: price(TRIAL_MARKETS.sp500, 600),
    [TRIAL_MARKETS.nasdaq]: price(TRIAL_MARKETS.nasdaq, 500),
  }, now, undefined, {}, TRIAL_PROFILE);
  assert.equal(state.markets.length, 5);
  assert.equal(state.basis.length, 1);
  assert.equal(state.basis[0]!.baseSymbol, TRIAL_MARKETS.bitcoin);
  assert.equal(state.basis[0]!.comparisonSymbol, TRIAL_MARKETS.wrappedBitcoin);
  const scan = scanConvergence(state, 50);
  assert.equal(scan.signals.length, 1);
  assert.equal(scan.signals[0]!.referenceSymbol, TRIAL_MARKETS.bitcoin);
  assert.equal(scan.signals[0]!.discountBps, 125);
  assert.equal(scan.signals[0]!.actionable, false);
  assert.ok(scan.signals[0]!.issues.includes("SOLANA_VENUE_NOT_VERIFIED"));
  assert.ok(state.markets.find(row => row.symbol === TRIAL_MARKETS.tesla)!.issues.includes("EQUITY_MARKET_NOT_REGULAR"));
  assert.ok(!scan.signals[0]!.issues.includes("EQUITY_MARKET_NOT_REGULAR"));
});

test("trial reader requests only entitled profile symbols and never fills a failed feed", async () => {
  const requested: MarketSymbol[] = [];
  const state = await readMarketState({ fetchLatest: async symbol => {
    requested.push(symbol);
    if (symbol === TRIAL_MARKETS.wrappedBitcoin) throw new Error("PYTH_FEED_NOT_ENTITLED");
    return price(symbol, 100);
  } }, TRIAL_PROFILE);
  assert.deepEqual(requested, TRIAL_PROFILE.symbols);
  assert.equal(state.markets.find(row => row.symbol === TRIAL_MARKETS.wrappedBitcoin)!.price, null);
  assert.equal(state.basis.length, 0);
  assert.equal(scanConvergence(state, 0).signals.length, 0);
  assert.equal(selectMarketProfile().id, "free-trial");
  assert.equal(selectMarketProfile("apple").id, "apple");
  assert.throws(() => selectMarketProfile("unknown"), /PYTH_MARKET_PROFILE/);
});

test("each trial feed must match its verified feed ID", () => {
  for (const symbol of TRIAL_PROFILE.symbols) {
    assert.equal(parsePythLatest(symbol, pythPayload("20000000", now * 1_000, FEED_IDS[symbol])).feedId, FEED_IDS[symbol]);
    assert.throws(() => parsePythLatest(symbol, pythPayload("20000000", now * 1_000, 922)), /Unexpected Pyth feed ID/);
  }
});
