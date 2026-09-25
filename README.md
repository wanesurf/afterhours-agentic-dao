# Afterhours Agentic DAO

Afterhours is a governed autonomous agent for tokenized markets on Solana.
Token holders approve strategy mandates through Realms. Hosted Hermes reasons
about those mandates and coordinates a modular MCP stack. Deterministic services
find market opportunities, enforce risk limits, execute approved actions, and
publish transaction receipts. Anyone can also converse
with a read-only agent to understand strategies, decisions, and results.

The planned stock strategy compares three Pyth markets:

- `Equity.US.AAPL/USD` — the regular Apple equity feed.
- `Crypto.AAPLX/USD` — the xStocks Apple feed.
- `Crypto.AAPLON/USD` — the Ondo Apple feed.

The strategy measures the basis between the underlying equity and both tokenized
representations, then validates every signal against executable Solana quotes,
fees, liquidity, slippage, freshness, and the active DAO mandate.

## Repository map

- `apps/web` — governance, public read-only chat, strategy status, positions, and public receipts.
- `services/agent` — Hosted Hermes configuration, prompt, and Afterhours skill.
- `services/arbitrage-mcp` — deterministic Pyth market scanner and opportunity tools.
- `services/execution-mcp` — policy-gated transaction simulation and execution.
- `services/governance-mcp` — Realms reads and structured unsigned proposal drafts.
- `services/governance-monitor` — proposal subscriptions, reconciliation, and Hermes wake events.
- `packages/dao-client` — Realms proposal and mandate access.
- `packages/strategy-engine` — shared strategy, risk, and opportunity types.
- `packages/mcp-clients` — adapters for Pyth, Hummingbot, Meteora, and other MCPs.
- `programs` — optional Solana programs when an onchain primitive is required.
- `scripts` — operational scripts added only when they perform a real workflow.
- `docs` — architecture, strategy, security, decisions, and hackathon scope.
- `legacy/robinhood` — the original Robinhood Chain agent, dashboard, and Solidity contracts.

## Legacy Robinhood desk

The complete RH agent, dashboard, Solidity contracts, and tests are included in
[`legacy/robinhood`](legacy/robinhood/README.md). Source provenance and import scope
are documented in [`IMPORT.md`](legacy/robinhood/IMPORT.md). This standalone npm
package is separate from the Solana build. The deployed historical desk remains at
<https://rh.afterhouragent.xyz/>.

```sh
npm ci --prefix legacy/robinhood
pnpm test:legacy
npm run preview:legacy
```

## Current status

The landing page, manifesto, and read-only market monitor are deployed at
https://afterhouragent.xyz. The source repository is private at
https://github.com/wanesurf/afterhours-agentic-dao. The deployed `/demo` page
combines live finalized governance reads with six synthetic policy scenarios
and downloadable decision records. See [the demo runbook](docs/demo-runbook.md)
for the exact walkthrough and current evidence.

The live trial profile uses five feeds confirmed accessible on 2026-09-25:
BTC (1), WBTC (103), TSLA (1435), VOO (1472), and QQQ (1363).
Only BTC/WBTC is compared; equities and ETFs provide observation-only context.
This reference spread does not establish executable arbitrage or a Solana venue.
The adapter validates feed IDs, freshness, market sessions, confidence, and
publisher counts. Failed live requests are never replaced with sample prices.
Without a key, prices are explicitly synthetic.

`PYTH_MARKET_PROFILE=free-trial` is the runtime default. Set it to `apple` after
obtaining Apple equity, xStocks, and Ondo access; those three feeds currently
return `PYTH_FEED_NOT_ENTITLED`. The six policy rehearsal cases still use clearly
labeled synthetic Apple inputs, independently of the live trial watchlist.

The new governance adapter decodes the deployed governance account's proposal
thresholds, voting settings, native treasury balance, and actual proposal states.
Reads validate account ownership and Realm/mint bindings at finalized commitment.
They do not authorize execution. The current proposal is a completed council
metadata proposal, not an approved trading mandate.

Execution preflight and proposal review functions exist, but live venue quoting,
a funded strategy vault, transaction simulation/signing, and settlement do not.
Public chat uses anonymous sessions and a server-side, tool-free Hermes adapter;
a verified externally reachable Hermes API is still needed for live replies.

```sh
pnpm install --frozen-lockfile
pnpm test
WEB_PORT=8786 WEB_ORIGIN=http://localhost:8786 node --env-file=.env dist/apps/web/src/server.js
# In another terminal:
pnpm demo:check http://localhost:8786
```

Open `/demo` for the governed-desk rehearsal and `/markets` for the price monitor.
The demo makes no transactions. Policy test records are explicitly synthetic;
their hashes are not onchain transaction signatures. The session store supports
one web process. The governed-desk release and five live trial feeds were verified in production on
2026-09-25 (Railway deployment `969ba1c7-bf0b-4d36-8804-ebd50e77ff75`).

## Design principles

1. The DAO governs policy; the agent executes within it.
2. Hermes never receives an unrestricted treasury signing tool.
3. Pyth supplies independent market data; venue quotes determine executability.
4. Every state-changing action passes through the policy gateway.
5. Every decision and transaction produces an auditable receipt.
6. MCP capabilities are modular and can be added through DAO-approved upgrades.
7. Public conversation is isolated from execution and governance authority.
8. Strategies improve through measured performance and DAO-approved upgrades.

See [docs/architecture.md](docs/architecture.md) and
[docs/implementation-status.md](docs/implementation-status.md),
[docs/pyth-arbitrage-strategy.md](docs/pyth-arbitrage-strategy.md), and
[docs/holder-agent-chat.md](docs/holder-agent-chat.md),
[docs/mcp-stack.md](docs/mcp-stack.md), and
[docs/proposal-lifecycle.md](docs/proposal-lifecycle.md).
