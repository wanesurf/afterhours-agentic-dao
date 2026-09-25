export const ARBITRAGE_MCP_TOOLS = [
  "get_market_state",
  "scan_opportunities",
] as const;

export type ArbitrageMcpTool = (typeof ARBITRAGE_MCP_TOOLS)[number];
