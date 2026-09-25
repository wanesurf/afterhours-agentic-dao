# ADR-005: Use Hummingbot for Meteora DLMM access

## Status

Accepted

## Context

The agent needs executable Meteora quotes, swaps, pool information, liquidity
positions, and fee collection. Hummingbot Gateway already exposes these
operations through its Meteora DLMM connector and makes them available through
the Hummingbot trading stack.

## Decision

Use Hummingbot for Meteora DLMM market data and execution. Do not build a
separate general-purpose Meteora MCP for the hackathon. All write operations
remain behind the Afterhours Execution MCP and its Realms policy checks.

Add a narrow direct Meteora adapter only when a required operation is absent
from Hummingbot, including possible DAMM v2 or Dynamic Bonding Curve management.

## Alternatives considered

- Build a full Meteora MCP: duplicates Hummingbot's connector and increases the
  number of privileged execution surfaces.
- Call Meteora SDKs directly for every operation: offers maximum control but adds
  implementation and maintenance work before a concrete gap exists.
- Use Hummingbot directly from Hermes for writes: simpler but bypasses the
  deterministic Realms mandate and simulation boundary.

## Consequences

The MVP has one Meteora execution path and can use Hummingbot's existing DLMM
coverage. DAMM v2 and DBC operations are outside this connector's documented
scope and require a later focused adapter if the DAO chooses to manage them.
