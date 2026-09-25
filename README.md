# Afterhours

**The Agentic DAO for tokenized markets.**

<img width="1360" height="768" alt="hf_20260925_135121_0c879339-b85a-467b-b68a-37631c0e5e24 (1)" src="https://github.com/user-attachments/assets/db02ef08-d6c3-43af-a1d0-4dab56375497" />


Holders set the mandate. An agent executes it. Every action leaves a receipt.

Afterhours is a governed autonomous agent on Solana. `$AFTERHOURS` holders approve strategy mandates through [Realms](https://v2.realms.today/dao/HLbzfAQP4b5oFBh8CeQ6DQSX1zr8kjjejxuywU2yYeCK). Hosted Hermes reasons about those mandates and coordinates a modular MCP stack. Deterministic services find market opportunities, enforce risk limits, execute approved actions, and publish transaction receipts. Anyone can talk to a read-only agent to understand strategies, decisions, and results.

DAOs are transparent and slow. Trading agents are fast, usually owned by one operator, and unsafe to leave unsupervised. Afterhours combines both. Humans judge. The agent executes. It cannot vote.

**Manifesto:** [afterhouragent.xyz/manifesto](https://afterhouragent.xyz/manifesto)

## Live surfaces

| What | Where |
| --- | --- |
| Product | https://afterhouragent.xyz |
| Manifesto | https://afterhouragent.xyz/manifesto |
| Migration ledger | https://migration.afterhouragent.xyz |
| Realms DAO | https://v2.realms.today/dao/HLbzfAQP4b5oFBh8CeQ6DQSX1zr8kjjejxuywU2yYeCK |
| Telegram | https://t.me/afterhoursdao |
| X | https://x.com/AfterHoursDAO |
| Founder | https://x.com/helwan_mande |

Solana token: `A9FBHUz352WGYC3GUpPdQe1bKUCLojvLMsa5uxatuYwn`

## How it works

1. Holders use Realms to approve a treasury mandate: strategy, assets, budget, duration, venues, and risk limits.
2. The agent checks that mandate against its skills and tells holders whether it can execute, what is missing, and the risk. It cannot vote.
3. The DAO allocates a capped amount to an isolated strategy vault. The agent never receives the main treasury.
4. The agent monitors approved markets and uses Pyth to test execution conditions.
5. A Clawpump-powered agent executes through Solana venues such as Meteora.
6. Principal and results return to the DAO. The interface ties proposal, decision, transaction, and outcome.

100% of `$AFTERHOURS` creator fees go to the DAO treasury. Agent-generated profits return to that same treasury. Holders decide what happens next.

## Planned stock strategy

The planned stock strategy compares three Pyth markets:

- `Equity.US.AAPL/USD`: the regular Apple equity feed
- `Crypto.AAPLX/USD`: the xStocks Apple feed
- `Crypto.AAPLON/USD`: the Ondo Apple feed

The strategy measures the basis between the underlying equity and both tokenized representations, then validates every signal against executable Solana quotes, fees, liquidity, slippage, freshness, and the active DAO mandate.

## Repository map

- `apps/web`: governance, public read-only chat, strategy status, positions, and public receipts
- `services/agent`: Hosted Hermes configuration, prompt, and Afterhours skill
- `services/arbitrage-mcp`: deterministic Pyth market scanner and opportunity tools
- `services/execution-mcp`: policy-gated transaction simulation and execution
- `services/governance-mcp`: Realms reads and structured unsigned proposal drafts
- `services/governance-monitor`: proposal subscriptions, reconciliation, and Hermes wake events
- `packages/dao-client`: Realms proposal and mandate access
- `packages/strategy-engine`: shared strategy, risk, and opportunity types
- `packages/mcp-clients`: adapters for Pyth, Hummingbot, Meteora, and other MCPs
- `programs`: optional Solana programs when an onchain primitive is required
- `scripts`: operational scripts added only when they perform a real workflow
- `docs`: architecture, strategy, security, decisions, and hackathon scope
- `legacy`: the original agent, dashboard, and contracts from the first desk

## First desk

The first Afterhour ran as a standalone desk: creator fees funded the wallet, x402 paid for market data, and the agent traded tokenized names after the listed close. The complete agent, dashboard, contracts, and tests live in [`legacy`](legacy/README.md). This package is separate from the Solana build.

```sh
npm ci --prefix legacy
pnpm test:legacy
npm run preview:legacy
