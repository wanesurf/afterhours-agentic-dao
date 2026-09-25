# Tests

Run `pnpm test` for the Pyth scanner, MCP protocol, policy checks, and holder
wallet/chat authentication tests. The holder tests use real Ed25519 signatures
with generated test keys and mocked balances/Hermes responses; no wallet assets
or paid model calls are involved.

Add focused tests with each implementation. Priority coverage:

- Pyth fixed-point normalization, freshness, and market-session handling.
- AAPL/AAPLX/AAPLON basis calculations.
- Net edge after fees, slippage, transaction cost, and safety buffer.
- Rejection of expired mandates, stale quotes, excess exposure, and duplicate execution.
- Exact transaction simulation-to-signature binding.
- Receipt reconciliation against confirmed Solana transactions.
