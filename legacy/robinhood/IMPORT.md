# Legacy Robinhood source import

Imported on 2026-09-25 from the `stocklana` working tree. The base Git revision
was `67944a415f80785862a68c0ad7a106787722bb66`. Uncommitted source changes present at import time are included;
this is not a pristine checkout of that revision. `import-manifest.json` records
SHA-256 hashes of every imported source file before the documented adaptations.

## Included

- The Robinhood Chain agent: Pons USDG creator-fee claims, x402 oracle access,
  stock screening, Uniswap execution, receipt reconciliation, exit and buyback policies.
- Dashboard source and served assets, public status/receipt endpoints, and chat.
- Solidity governance/treasury source, unit tests, optional fork tests, and Foundry config.
- Agent tests, operational scripts, npm manifest/lockfile, Dockerfile, and original docs.
- Empty credential fields in `.env.example`; execution and publishing stay opt-in.

## Scope and adaptations

The separate migration portal, holder snapshots, payout records, and its three
migration-only tests are excluded. Removed the five `migration:*` npm commands
and the migration OG generator, which depend on that separate app. No agent or
contract source was modified. The npm lockfile is preserved, including dependencies
previously shared with the migration app, to keep dependency versions reproducible.
README gains import/run instructions; ignore rules also exclude local secrets,
ledgers, runtime checkouts, Foundry artifacts, and coverage.

The pinned third-party MCP source is not vendored. `npm run setup:upstream`
retrieves revision `4a1c9859d25e9ee98853923bb787421a5c6d2585` of
`glabun002/after-hours-dip-agent` into ignored `.runtime/` when explicitly run.

## Development

This is a standalone npm project outside the root pnpm workspace globs. Install
with `npm ci --prefix legacy/robinhood`, then use `pnpm test:legacy` from the repo
root. For contract unit tests, run `npm run contracts:test` from this directory
with Foundry installed. Fork tests and deployment scripts are separate opt-in commands.

`npm run preview:legacy` serves the local dashboard without starting the trading
watcher. It has no historical ledger until explicitly configured; importing source
does not import production trades or private state. The existing live desk remains
at <https://rh.afterhouragent.xyz/>.

The root Solana Docker build and Railway upload exclude `legacy/`. Importing this
folder does not deploy the RH agent, sign transactions, send messages, or change
production funds. Legacy documentation describes RH behavior, not completed Solana
execution. The new Solana mandate/vault/execution work remains separate.

## Verification on 2026-09-25

- Legacy Node agent tests: **81 passed**.
- Solidity unit tests (`forge test --offline`, Solc 0.8.28): **12 passed**.
- Current Solana/demo tests: **31 passed**.
- `npm run build:web` succeeded using the imported lockfile and dependencies.
- Import scan found no matches for configured credential values or known secret patterns.
- Git ignore checks cover local env files, runtime data, installed dependencies,
  and generated Solidity artifacts. The migration-only app and tests are excluded.

No live watcher, transaction, publishing operation, fork test, or deployment was
run as part of verification. Agent HTTP tests use fixtures and mocked services.
