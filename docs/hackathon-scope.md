# Stocklana hackathon scope

## Product target

A DAO approves an executable mandate, allocates capped capital to an isolated
vault, and receives the proceeds and receipts from an agent operating within its
limits. Pyth reference data informs decisions; executable venue quotes determine
actual trades. The end-to-end funded-vault path is not implemented yet.

## Demonstrable build

- Live finalized Solana governance settings, treasury SOL balance and proposals.
- Pyth Pro adapter and read-only Arbitrage MCP for AAPL, AAPLX and AAPLON.
- Explicit feed access, freshness, confidence and market-session error states.
- Deterministic execution preflight and six synthetic policy rehearsals.
- Downloadable decision records with content hashes, never presented as trades.
- Roman landing page, manifesto and the integrated governed-desk demo.
- Public conversation interface without wallet gating; live Hermes replies still
  need a reachable authenticated API endpoint.
- Separate historical Robinhood execution evidence and migration ledger.

## Integration gaps

The configured Pyth key lacks access to the three required feeds. Hosted Hermes
is not externally connected to the website. Venue quotes, executable mandate
instructions, strategy vault funding, exact transaction simulation, restricted
signing, confirmation and settlement remain missing. Clawpump execution,
PreStocks execution and x402 market-data payments on Solana are not implemented.

## Later product direction

Multiple strategy vaults, DAO-authorized capabilities and code upgrades, TEE
execution, OMP integration, additional assets, and measured strategy improvement.

See [demo runbook](demo-runbook.md) for tested steps and submission wording.
