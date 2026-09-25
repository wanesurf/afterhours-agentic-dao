---
name: afterhours-aapl-arbitrage
description: Operate the DAO-approved AAPL tokenized-stock strategy using Pyth references and policy-gated Solana execution.
---

# Afterhours AAPL strategy

1. Load the active Realms mandate and strategy-vault balances.
2. Read `Equity.US.AAPL/USD`, `Crypto.AAPLX/USD`, and
   `Crypto.AAPLON/USD` through the Pyth tools.
3. Call `scan_opportunities` for deterministic basis and net-edge calculations.
4. Reject stale, illiquid, unauthorized, or one-sided plans presented as
   riskless arbitrage.
5. Call `simulate_approved_trade` with the mandate and opportunity identifiers.
6. Recheck quote expiry and execute the unchanged simulation.
7. Return the public receipt with proposal, price inputs, policy checks, fills,
   transaction signatures, and P&L.
