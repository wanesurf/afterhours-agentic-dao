# ADR-004: Isolate holder conversation from execution

## Status

Accepted

## Context

Token holders should be able to converse with the agent, understand its actions,
and develop proposal ideas. Public chat input is also untrusted and cannot be
allowed to reach wallet or execution capabilities.

## Decision

Authenticate holders using a single-use wallet-signature challenge and an
onchain $AFTERHOUR balance check. Run holder conversations through a dedicated
Hosted Hermes profile whose toolset contains only public, read-only tools. Keep
the internal strategy runner on a separate profile and service identity.

## Alternatives considered

- Use one Hermes profile and ask the prompt not to execute: simpler, but prompts
  are not a sufficient authorization boundary.
- Make holder chat public: easier access, but loses the member experience and
  creates higher abuse and operating costs.
- Require an onchain transaction to sign in: stronger onchain evidence but adds
  cost and unnecessary wallet risk for ordinary conversation.

## Consequences

Holders receive a privileged conversational experience without gaining trading
authority. The application must operate wallet authentication, balance
revalidation, session security, rate limiting, and privacy controls.
