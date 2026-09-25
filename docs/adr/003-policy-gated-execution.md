# ADR-003: Gate every state-changing action behind deterministic policy

## Status

Accepted

## Context

An agent needs autonomy inside a mandate without obtaining unrestricted control
of the DAO treasury.

## Decision

Use an isolated strategy vault and delegated signer. The Execution MCP reloads
finalized Realms state, checks every limit, simulates exact instructions, and
signs only an unchanged approved transaction.

## Alternatives considered

- Give Hermes a treasury key: operationally simple but incompatible with the
  governance and risk model.
- Require a holder vote for every trade: secure but too slow for execution.

## Consequences

Holders govern policy while the agent can act at market speed. The policy gateway
and signer become critical security components and require focused testing.
