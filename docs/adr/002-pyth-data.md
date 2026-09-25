# ADR-002: Separate conversational Pyth access from the live scanner

## Status

Accepted

## Context

Hermes benefits from Pyth discovery and historical tools, while arbitrage
scanning requires continuous, deterministic, low-latency calculations.

## Decision

Connect Hermes to the official Pyth MCP and let the Afterhours Arbitrage MCP
consume Pyth Pro streams directly.

## Alternatives considered

- Pass all prices through Hermes: simpler but adds latency and non-deterministic
  arithmetic to the execution path.
- Use only venue prices: loses the independent equity and tokenized-stock
  reference central to the product and Pyth track.

## Consequences

Pyth remains central to both agent reasoning and trading evidence. The scanner
requires secure server-side handling of the Pyth Pro token and redundant stream
connections.
