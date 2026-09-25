# Afterhours Arbitrage MCP

The first working slice requests Pyth Pro market data when either MCP tool is
called. It exposes deterministic market state and read-only convergence scans to
Hosted Hermes. Streaming, venue quotes, backtests, strategy control, and trade
receipts are subsequent work.

It holds no treasury key and exposes no state-changing tools. A future
Execution MCP will reload the Realms mandate before any signed action.

## Initial universe

- `Equity.US.AAPL/USD` — Pyth Pro feed ID 922.
- `Crypto.AAPLX/USD` — Pyth Pro feed ID 1792.
- `Crypto.AAPLON/USD` — Pyth Pro feed ID 3132.

These IDs were checked against [Pyth's public symbol catalog](https://docs.pyth.network/price-feeds/pro/api/history).
The parser rejects an unexpected ID even if the response has the requested
price fields.

The scanner calculates AAPLX/AAPL, AAPLON/AAPL, and AAPLX/AAPLON basis. A signal
becomes executable arbitrage only when both required legs can be completed or
properly hedged. Without that condition it remains a price-dislocation signal.

## Run locally

```sh
pnpm install
pnpm test
PYTH_PRO_ACCESS_TOKEN=your_server_side_key pnpm start:arbitrage-mcp
```

The server binds `127.0.0.1:8781` by default. `GET /health` checks the process;
`POST /mcp` is the MCP endpoint. Set `PORT`, `HOST`, and
`ARBITRAGE_MCP_TOKEN` in the deployment environment. A non-local bind requires
the bearer token. Configure Hosted Hermes with the same token through its
`Authorization` header, as shown in the Hermes configuration template. Keep
`PYTH_PRO_ACCESS_TOKEN` and the MCP bearer token in secret storage.

`get_market_state` returns each feed's raw mantissa, exponent, normalized USD
price, confidence, publisher count, market session, stream time, and feed update
time. It also returns the three basis readings when both feeds are present.

`scan_opportunities` returns AAPLX and AAPLON discounts to the Apple equity
reference. Each signal is classified as `price-dislocation` and explicitly
`actionable: false`. Stale or carried-forward prices and a closed equity session
are surfaced as issues. Venue quotes and a governed execution path must be added
before any signal can become a trade plan.
