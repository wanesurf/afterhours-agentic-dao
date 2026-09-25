# ADR 006: Structured proposals and governance events

- Status: accepted
- Date: 2026-09-24

## Context

Afterhours needs holders to propose new strategies and upgrades while keeping
agent execution deterministic. Realms proposals are general purpose, and proposal
descriptions may contain arbitrary text. Hosted Hermes also needs a reliable way
to react when proposal state changes.

## Decision

Use a versioned Afterhours proposal schema and a template-based proposal builder.
The builder compiles structured input into exact Realms proposal transactions that
write an onchain strategy mandate or approved artifact hash.

For the first release, configure Realms' onchain minimum community proposal weight
to `X`. The agent drafts and validates; an eligible holder remains the onchain
proposal creator and signs with their own wallet. Realms may still accept general
proposals from any holder above `X`, while Afterhours automation acts only on
recognized instructions.

An exclusive proposal gateway may later use an action-scoped voter-weight addin for
`CreateProposal`. Hermes must not hold the gateway key.

Run a governance monitor that watches Realms accounts over Solana WebSocket, uses
polling for recovery, persists idempotent events, and wakes Hosted Hermes. Hermes
then reads canonical proposal data through the Governance MCP.

Only allowlisted, decoded, simulated and finalized proposal transactions may be
executed automatically. Unknown proposals remain visible and analyzable but are
never machine-executed by Afterhours.

Do not delegate voting power to Hermes in the initial release.

## Consequences

- Holders receive proposal flexibility through explicit action templates.
- The description remains useful for context but has no execution authority.
- Directly created Realms proposals cannot trick the agent into a trade or upgrade.
- WebSocket delivery can fail without losing events because polling and an outbox
  reconcile missed state.
- New proposal types require a schema version, decoder, validator, UI template,
  simulation path, and DAO-approved program or capability allowlist.
