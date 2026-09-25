# Pyth AAPL arbitrage strategy

## Objective

Detect and trade price differences among:

- `Equity.US.AAPL/USD` — regular Apple equity reference.
- `Crypto.AAPLX/USD` — xStocks representation.
- `Crypto.AAPLON/USD` — Ondo representation.

The scanner computes:

- AAPLX versus AAPL basis.
- AAPLON versus AAPL basis.
- AAPLX versus AAPLON basis.

## Data path

The official Pyth MCP supports feed discovery, current and historical price
queries, and charts for Hermes. The scanner separately consumes Pyth Pro streams
so timing and arithmetic remain deterministic. It records price, confidence,
market session, feed update time, and publisher count.

Executable buy and sell prices come from Solana venues through Hummingbot or a
venue adapter. Pyth provides the independent reference and evidence attached to
the trade receipt.

## Freshness and market hours

An equity price may be carried forward while the underlying market is closed.
The scanner compares `feedUpdateTimestamp` with the stream timestamp and checks
`marketSession`. A carried-forward equity price is context, not a live execution
anchor.

During regular market hours, all three feeds may be compared with the live
underlying reference. Outside regular hours, the scanner emphasizes actively
updating tokenized-stock feeds and executable venue quotes while preserving the
last equity price as context.

## Classification

A spread is `executable-arbitrage` only when the required legs can be completed
or properly hedged, sufficient liquidity exists, and the expected result remains
positive after all costs. Otherwise it is `price-dislocation`.

Spot-only execution may require the vault to hold inventory of AAPLX and AAPLON.
Without inventory, borrowing, shorting, redemption, or conversion, the agent may
only take a directional relative-value position.

## Net edge

```text
gross profit = sell proceeds - buy cost

net profit = gross profit
             - venue fees
             - expected slippage
             - transaction costs
             - safety buffer

net edge bps = net profit / buy notional * 10,000
```

Execution requires a positive net edge above the DAO-approved minimum and a
fresh successful simulation.

## Strategy evolution

This is the DAO's first governed strategy and is designed to improve over time.
The initial release uses conservative, one-sided convergence trades with strict
position, freshness, holding-time, and loss limits. Performance and execution
receipts give holders evidence for each proposed improvement.

Future DAO-approved upgrades can add:

- Inventory-based paired execution between AAPLX and AAPLON.
- Simultaneous hedging or issuer redemption to reduce Apple market exposure.
- Thresholds calibrated from Pyth history and realized venue costs.
- Additional tokenized equities, issuers, and execution venues.
- New MCP capabilities and strategy-specific risk modules.

Every material change to code, MCP access, assets, venues, or risk limits follows
the governance and deployment-approval process before reaching production.

## Initial demo

1. Display the three Pyth feeds and freshness metadata.
2. Display executable venue quotes.
3. Calculate all three basis readings.
4. Classify the strongest signal.
5. Load the Realms mandate and show each policy check.
6. Simulate the complete trade plan.
7. Execute on devnet or in a controlled mainnet vault.
8. Publish the proposal link, Pyth evidence, fills, signatures, and P&L receipt.
