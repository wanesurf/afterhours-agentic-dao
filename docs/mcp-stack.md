# MCP stack

## Pyth MCP

The official hosted Pyth MCP gives Hosted Hermes feed discovery, current and
historical prices, and chart data. The deterministic Arbitrage MCP separately
consumes Pyth Pro streams for freshness-sensitive calculations.

## Afterhours Arbitrage MCP

This custom read-oriented service calculates AAPL/AAPLX/AAPLON basis, validates
feed freshness and market sessions, requests executable quotes, classifies price
dislocations, and records opportunity evidence. It proposes plans but does not
sign transactions.

## Hummingbot MCP and API

Hummingbot supplies market data, portfolio state, backtesting, bot orchestration,
DEX Gateway access, and order or swap operations. We expose only read operations
to Hermes. Policy-approved execution reaches Hummingbot through the Execution MCP
over a private authenticated connection.

### Meteora coverage

Hummingbot Gateway's Meteora connector currently documents DLMM support for:

- Swap quotes and swap execution.
- Pool discovery and pool information.
- Position information and positions owned.
- Position quotes.
- Opening and closing positions.
- Adding and removing liquidity.
- Collecting fees.

The first strategy should use this connector rather than duplicate it in a
separate Meteora MCP.

The documented connector is DLMM-specific. If Afterhours later needs direct
control of the Clawpump DAMM v2 pool, Dynamic Bonding Curve, or an instruction
that Hummingbot does not expose, add a narrow Meteora adapter inside the
Execution MCP using Meteora's official SDK. Do not create a second general
Meteora control plane.

## Realms Governance MCP

This custom MCP wraps Solana RPC and the maintained governance SDK. It exposes
realm configuration, proposals, proposal transactions, voting power, treasury
state, active strategy mandates, and executed upgrade history.

Holder and internal-agent profiles may read governance data and create unsigned,
structured proposal drafts. They cannot cast votes, approve proposals, or execute
proposal transactions. Drafts compile to exact allowlisted instructions; freeform
text has no authority. The Execution MCP reads finalized onchain mandate state
directly before every state-changing action.

## Governance monitor

The monitor is an event bridge, not an MCP. It watches Realms accounts with a
Solana WebSocket subscription and uses polling to recover missed changes. It
persists idempotent events, then wakes Hosted Hermes with the event type and
onchain addresses. Hermes fetches canonical proposal data through the Governance
MCP. Unknown proposal instructions are analyzable but never automatically
executed. See [proposal-lifecycle.md](proposal-lifecycle.md).

## Access separation

| Capability | Public chat | Internal agent | Execution service |
|---|---:|---:|---:|
| Pyth market data | Read | Read | Read |
| Arbitrage scanner and receipts | Read | Read | Read |
| Hummingbot market data | Public read | Read | Read |
| Hummingbot trading | No | No direct access | Policy-gated |
| Meteora DLMM data through Hummingbot | Public read | Read | Read |
| Meteora DLMM transactions through Hummingbot | No | No direct access | Policy-gated |
| Realms proposals and mandates | Read | Read | Required |
| Structured proposal drafting | Draft only | Draft only | No |
| Proposal event notifications | Read | Read | Internal trigger only |
| Voting or proposal approval | No | No | No |
| Strategy signing | No | No | Delegated signer only |
