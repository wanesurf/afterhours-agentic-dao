# Security model

## Assets

- DAO treasury and strategy-vault funds.
- Delegated strategy signer.
- Pyth Pro access token.
- MCP service credentials.
- Anonymous browser sessions and private chat history.
- Governance and execution audit records.

## Execution controls

- Keep the DAO treasury under Realms governance.
- Fund isolated strategy vaults with explicit maximum exposure.
- Store all secrets in deployment secret managers, never in the repository.
- Permit signing only after a fresh mandate read and transaction simulation.
- Bind simulations to exact instructions and reject any mutation before signing.
- Enforce symbol, venue, size, slippage, profit, duration, and loss limits.
- Provide an onchain or independently authenticated emergency pause.
- Use idempotency keys to prevent duplicate execution.
- Reconcile submitted transactions against confirmed Solana state.

## Public conversation controls

- No wallet connection, token ownership, or signature is required for chat.
- Use random, expiring HTTP-only same-site browser sessions, with Secure cookies
  on HTTPS. Keep histories private to each session.
- Validate request origins and sizes; accept message text only from the client.
- Limit completions per session and IP, including across newly created cookies.
- A new chat clears local history and rotates the upstream conversation ID.
- Conversation identity is never accepted as proposal, vote, or trade authority.
- The optional wallet-auth helper remains separate from the public chat routes.

## Agent boundary

The internal Hermes runner can request policy-gated actions but cannot change the
policy or access an unrestricted signer. The public-chat Hermes API exposes
no tools and has no route to simulation or execution. Prompting is an
additional instruction layer, not the security boundary.

Tool output and visitor messages are untrusted input until parsed and checked by
deterministic code. Wallet authentication proves control of an address for the
current session; it does not constitute a vote or authorization to trade.
