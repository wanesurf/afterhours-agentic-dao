import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { selectMarketProfile } from "./markets.js";
import { PythProMarketClient } from "./pyth-pro.js";
import { readMarketState, scanConvergence, type MarketState } from "./scanner.js";

export interface MarketStateProvider {
  read(): Promise<MarketState>;
}

function sameToken(expected: string, supplied: string | undefined): boolean {
  if (!supplied?.startsWith("Bearer ")) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied.slice(7));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createArbitrageMcpHttpServer(provider: MarketStateProvider, bearerToken = ""): Server {
  return createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "afterhours-arbitrage-mcp" }));
      return;
    }
    if (pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (bearerToken && !sameToken(bearerToken, req.headers.authorization)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const mcp = new McpServer({ name: "afterhours-arbitrage", version: "0.1.0" });
    mcp.registerTool("get_market_state", {
      description: "Read the configured Pyth market profile, prices, quality checks, and comparable reference spreads. Read only.",
      annotations: { readOnlyHint: true },
    }, async () => {
      const result = await provider.read();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
    mcp.registerTool("scan_opportunities", {
      description: "Find discounts within the configured reference pairs (BTC/WBTC trial or Apple equity/tokenized markets). Results are non-executable dislocations until venue quotes and governance checks exist.",
      inputSchema: { minimumDiscountBps: z.number().finite().min(0).default(0) },
      annotations: { readOnlyHint: true },
    }, async ({ minimumDiscountBps }) => {
      const result = scanConvergence(await provider.read(), minimumDiscountBps);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Arbitrage MCP request failed", error);
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      await mcp.close();
    }
  });
}

export function startArbitrageMcpFromEnvironment(): Server {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || "8781");
  const bearerToken = process.env.ARBITRAGE_MCP_TOKEN || "";
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
  if (host !== "127.0.0.1" && host !== "localhost" && !bearerToken) {
    throw new Error("ARBITRAGE_MCP_TOKEN is required when the MCP binds outside localhost");
  }
  const profile = selectMarketProfile(process.env.PYTH_MARKET_PROFILE);
  const client = new PythProMarketClient(process.env.PYTH_PRO_ACCESS_TOKEN || "");
  const server = createArbitrageMcpHttpServer({ read: () => readMarketState(client, profile) }, bearerToken);
  server.listen(port, host, () => console.log(`Afterhours arbitrage MCP listening on ${host}:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startArbitrageMcpFromEnvironment();
}
