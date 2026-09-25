# ADR-001: Use Hosted Hermes as the orchestration runtime

## Status

Accepted

## Context

The hackathon needs an agent capable of reasoning across governance, market data,
and execution tools without spending the submission period maintaining an agent
runtime.

## Decision

Use Hosted Hermes with a restricted MCP toolset. Keep strategy calculations,
policy enforcement, signing, and receipts in services owned by Afterhours.

## Alternatives considered

- Self-host Hermes immediately: more control but more operational work.
- Build a custom agent loop: maximum control but duplicates mature orchestration.

## Consequences

The MVP ships faster and can use Hosted Hermes MCP support. The runtime remains
replaceable because authorization and execution do not live inside Hermes.
