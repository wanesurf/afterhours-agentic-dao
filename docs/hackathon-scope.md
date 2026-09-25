# Stocklana hackathon scope

## Submission goal

Demonstrate a governed agent that uses Pyth market data to find tokenized-stock
price dislocations, validates them against live Solana liquidity, and executes
within a holder-approved mandate. Authenticated holders can converse with the
agent and audit its reasoning without gaining execution authority.

## In scope

- One Realms-governed strategy vault.
- Hosted Hermes with separate internal and holder-chat toolsets.
- Wallet-signature authentication and $AFTERHOUR balance gating.
- A token-gated, read-only holder conversation with the agent.
- Official Pyth MCP integration.
- Direct Pyth Pro streaming in the Arbitrage MCP.
- The AAPL, AAPLX, and AAPLON comparison strategy.
- The agent Purchase Tessera and Pre stocks
- Hummingbot or venue quote integration.
- Policy validation, simulation, controlled execution, and public receipts.
- A web experience that explains the mandate and execution trail.
- A first governed strategy that can improve through transparent, DAO-approved upgrades.

## Later

- Multiple strategy vaults.
- Holder-delegated capital vaults and DAO performance fees.
- DAO-authorized MCP and code upgrades with attested deployments.
- Additional equities, issuers, venues, and hedging mechanisms.
- Confidential execution or TEE-backed signing infrastructure.
- Self improving agent (with OMP)
