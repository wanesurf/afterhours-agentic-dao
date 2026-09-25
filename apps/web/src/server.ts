import { createHermesRuntime } from "./hermes-runtime.js";
import { createChatRoutes, type ChatOptions } from "./chat-routes.js";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDaoStatus } from "../../../packages/dao-client/src/deployed-dao.js";
import { FEED_IDS, AAPL_MARKETS, TRIAL_MARKETS, APPLE_PROFILE, selectMarketProfile, type MarketProfile, type MarketSymbol, type ReferencePrice } from "../../../services/arbitrage-mcp/src/markets.js";
import { PythProMarketClient } from "../../../services/arbitrage-mcp/src/pyth-pro.js";
import { analyzePrices, readMarketState, scanConvergence, type MarketState } from "../../../services/arbitrage-mcp/src/scanner.js";

import { readGovernanceSnapshot } from "../../../packages/dao-client/src/governance.js";
import { runRehearsal, REHEARSAL_SCENARIOS, type RehearsalScenario } from "./rehearsal.js";
import { cachedReader } from "./cached-provider.js";

type DataMode = "sample" | "live";

export interface WebMarketProvider {
  read(): Promise<MarketState>;
}

function samplePrice(symbol: MarketSymbol, priceUsd: number, nowMs: number): ReferencePrice {
  return {
    symbol,
    feedId: FEED_IDS[symbol],
    priceUsd,
    confidenceUsd: 0.04,
    priceMantissa: String(Math.round(priceUsd * 100_000)),
    confidenceMantissa: "4000",
    exponent: -5,
    observedAtMs: nowMs,
    feedUpdatedAtMs: nowMs,
    marketSession: "regular",
    publisherCount: 4,
  };
}

export function sampleMarketState(nowMs = Date.now(), profile: MarketProfile = APPLE_PROFILE): MarketState {
  return analyzePrices({
    [AAPL_MARKETS.equity]: samplePrice(AAPL_MARKETS.equity, 200, nowMs),
    [AAPL_MARKETS.xStocks]: samplePrice(AAPL_MARKETS.xStocks, 195, nowMs),
    [AAPL_MARKETS.ondo]: samplePrice(AAPL_MARKETS.ondo, 198, nowMs),
    [TRIAL_MARKETS.bitcoin]: samplePrice(TRIAL_MARKETS.bitcoin, 80_000, nowMs),
    [TRIAL_MARKETS.wrappedBitcoin]: samplePrice(TRIAL_MARKETS.wrappedBitcoin, 79_500, nowMs),
    [TRIAL_MARKETS.tesla]: samplePrice(TRIAL_MARKETS.tesla, 300, nowMs),
    [TRIAL_MARKETS.sp500]: samplePrice(TRIAL_MARKETS.sp500, 600, nowMs),
    [TRIAL_MARKETS.nasdaq]: samplePrice(TRIAL_MARKETS.nasdaq, 500, nowMs),
  }, nowMs, undefined, {}, profile);
}

const STATIC_FILES = {
  "/demo": { file: "demo.html", contentType: "text/html; charset=utf-8" },
  "/demo.css": { file: "demo.css", contentType: "text/css; charset=utf-8" },
  "/demo.js": { file: "demo.js", contentType: "text/javascript; charset=utf-8" },
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/navigation.css": { file: "navigation.css", contentType: "text/css; charset=utf-8" },
  "/manifesto": { file: "manifesto.html", contentType: "text/html; charset=utf-8" },
  "/manifesto/": { file: "manifesto.html", contentType: "text/html; charset=utf-8" },
  "/manifesto.css": { file: "manifesto.css", contentType: "text/css; charset=utf-8" },
  "/landing.js": { file: "landing.js", contentType: "text/javascript; charset=utf-8" },
  "/markets": { file: "markets.html", contentType: "text/html; charset=utf-8" },
  "/markets.css": { file: "markets.css", contentType: "text/css; charset=utf-8" },
  "/markets.js": { file: "markets.js", contentType: "text/javascript; charset=utf-8" },
} as const;

export function createWebServer(provider: WebMarketProvider, mode: DataMode, chatOptions?: ChatOptions): Server {
  const governanceRead = cachedReader(() => readGovernanceSnapshot(), 15_000);
  const chatRoutes = chatOptions ? createChatRoutes(chatOptions) : undefined;
  return createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    if (chatRoutes && await chatRoutes(req, res, pathname)) return;
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (pathname === "/api/demo/rehearsal") {
      const scenario = new URL(req.url || "/", "http://localhost").searchParams.get("scenario") || "within-limits";
      if (!REHEARSAL_SCENARIOS.includes(scenario as RehearsalScenario)) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unknown rehearsal scenario." }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(runRehearsal(scenario as RehearsalScenario)));
      return;
    }
    if (pathname === "/api/governance") {
      try {
        const snapshot = await governanceRead();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(snapshot));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: "Finalized governance data is temporarily unavailable." }));
      }
      return;
    }
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mode }));
      return;
    }
    if (pathname === "/api/markets") {
      try {
        const state = await provider.read();
        const scan = scanConvergence(state, 50);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ mode, state, scan }));
      } catch (error) {
        console.error("Web market read failed", error);
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Market data is temporarily unavailable." }));
      }
      return;
    }
    if (pathname === "/api/dao") {
      try {
        const status = await readDaoStatus();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(status));
      } catch (error) {
        console.error("DAO status read failed", error);
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Finalized DAO account verification is temporarily unavailable." }));
      }
      return;
    }
    const assetTypes: Record<string, string> = { png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', woff2: 'font/woff2' };
    const asset = /^\/assets\/([a-z0-9-]+\.(png|webp|svg|woff2))$/.exec(pathname);
    const staticFile = asset ? { file: `assets/${asset[1]}`, contentType: assetTypes[asset[2]] } : STATIC_FILES[pathname as keyof typeof STATIC_FILES];
    if (!staticFile) {
      res.writeHead(404).end();
      return;
    }
    try {
      const path = fileURLToPath(new URL(`../../../../apps/web/public/${staticFile.file}`, import.meta.url));
      const content = await readFile(path);
      // Only content-fingerprinted images get permanent browser caching.
      // HTML and unversioned assets revalidate so site updates appear immediately.
      const cacheControl = asset && /-[a-f0-9]{12}\.(?:png|webp)$/.test(asset[1])
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      res.writeHead(200, { "content-type": staticFile.contentType, "content-length": content.byteLength, "cache-control": cacheControl });
      res.end(content);
    } catch (error) {
      console.error("Web asset read failed", error);
      res.writeHead(500).end();
    }
  });
}

export function startWebFromEnvironment(): Server {
  const host = process.env.WEB_HOST || "127.0.0.1";
  const port = Number(process.env.PORT || process.env.WEB_PORT || "8780");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid WEB_PORT");
  const profile = selectMarketProfile(process.env.PYTH_MARKET_PROFILE);
  const token = process.env.PYTH_PRO_ACCESS_TOKEN;
  const mode: DataMode = token ? "live" : "sample";
  const provider: WebMarketProvider = { read: cachedReader(token
    ? () => readMarketState(new PythProMarketClient(token), profile)
    : () => Promise.resolve(sampleMarketState(Date.now(), profile)), 2_000) };
  const origin = process.env.WEB_ORIGIN || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`);
  const server = createWebServer(provider, mode, {
    origin,
    runtime: createHermesRuntime(process.env.HERMES_API_URL, process.env.HERMES_API_KEY, { model: process.env.HERMES_API_MODEL }),
    evidence: async () => JSON.stringify({ mode, readAt: new Date().toISOString(), state: await provider.read() }),
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(port, host, () => console.log(`Afterhours read-only demo listening on http://${host}:${port} (${mode})`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWebFromEnvironment();
}
