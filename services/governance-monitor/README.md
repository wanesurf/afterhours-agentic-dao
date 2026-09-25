# Governance monitor

An event bridge between finalized Realms state and Hosted Hermes.

- Uses Solana WebSocket subscriptions for low-latency proposal changes.
- Polls periodically to recover missed notifications.
- Decodes proposal transactions before emitting an event.
- Stores idempotent events in an outbox or job queue.
- Wakes Hermes with addresses and event type, not trusted narrative text.
- Never treats a notification as execution authorization.
- May request permissionless execution only for recognized proposal transactions
  after success, hold-up, finalized re-read, simulation, and replay checks.

See `docs/proposal-lifecycle.md` for the complete flow.
