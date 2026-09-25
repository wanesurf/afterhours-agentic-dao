# Stocklana demo: run and verify

The current build demonstrates **live governance inspection and a complete local
policy rehearsal**. It does not demonstrate a DAO-funded Solana trade or settlement.
The rehearsal uses synthetic inputs and explicitly marks every record as such.

## Deployed demo and private source

- Demo: <https://afterhouragent.xyz/demo>.
- Repository: <https://github.com/wanesurf/afterhours-agentic-dao> (private).
- Railway deployment: `969ba1c7-bf0b-4d36-8804-ebd50e77ff75`, status `SUCCESS`.
- Production governance and all six policy scenarios passed HTTP checks.
- Production uses the live Pyth trial watchlist: BTC, WBTC, TSLA, VOO, and QQQ.
  Only BTC/WBTC forms a reference pair; the stocks/ETFs are context.
  All five passed production quality checks on 2026-09-25. The Pyth key is stored
  only server-side in Railway, with explicit user authorization.
- Source publication remains private by the owner's explicit request. A submission
  that requires public code will need a later visibility change or judge access.

## Start

```sh
pnpm install --frozen-lockfile
pnpm test
WEB_PORT=8786 WEB_ORIGIN=http://localhost:8786 node --env-file=.env dist/apps/web/src/server.js
```

Open <http://localhost:8786/demo>. The server-only `.env` stays ignored by Git,
Railway upload, and Docker. No wallet secret is required or accepted by this demo.

```sh
pnpm demo:check http://localhost:8786
# Requires configured live data and agent; exits nonzero while live gates are blocked:
pnpm demo:check http://localhost:8786 --require-live
```

The readiness report distinguishes passing checks from blocked integrations.
`fullFundedVaultDemoReady` remains false until the actual execution path exists.
The normal command verifies the supported rehearsal flow without pretending that
blocked external integrations passed. Chat readiness checks configuration, not a
model completion; a real conversation must also pass before claiming chat works.

## Two-minute walkthrough

1. Open **The governed desk**. Inspect the finalized governance settings and the
   actual proposal table. Follow the proposal explorer link.
2. Show the five trial feeds and BTC/WBTC spread. Read timestamps and quality
   labels. Tesla, VOO, and QQQ are observation only. Apple feeds need additional
   access; the separate policy scenarios remain explicitly synthetic Apple cases.
3. Run **Trade inside the limits**. The schema and risk precheck pass. Execution
   remains blocked because there is no connected approved mandate or signer.
4. Run **Trade exceeds the budget**, then **Reference price is stale**. Both must
   reject the candidate. Other cases cover pause, expiry, and no qualifying gap.
5. Download the decision JSON. It includes the manifest, its digest, synthetic
   prices and quote, failed checks, and `fundsMoved: false`. The SHA-256 identifies
   record content; it does not prove a transaction happened.
6. Show the existing Robinhood desk separately at <https://rh.afterhouragent.xyz/>
   for historical execution evidence. Do not describe those as Solana transactions.

## Verified on 2026-09-25

- 31 automated tests passed, including all six policy scenarios, HTTP routes,
  record integrity, governance account owner rejection, and explicit Pyth errors.
- Finalized governance read succeeded on mainnet.
- Governance account: `Haf7oXbQ1JREia8gWk9yv3ebtv9BXMiL1jgzo5LSVkhD`.
- Community proposal threshold: `1000000000000` raw voting units.
- Council proposal threshold: `1` raw voting unit.
- Both vote thresholds: 10% yes-vote percentage; voting period: 86,400 seconds;
  minimum instruction hold-up: zero. These values were decoded from the account;
  this does not verify voter-weight addin behavior or assert that every vote must
  wait 24 hours, since tipping rules may conclude a vote earlier.
- The sole proposal in this governance was **Verify DAO Metadata**, completed
  under the council population, with 3/3 instructions executed. No strategy
  proposal was present in this read.
- Native treasury: `C2AzjtqK7LCQ8yvUpxHq6noVeMGpK1MFoeaDyJayHBcF`; observed balance
  0.50692152 SOL. This is the governance native treasury, not an isolated strategy
  vault or the total value of all DAO assets.
- Pyth Pro returned HTTP 200 for BTC (1), WBTC (103), TSLA (1435), VOO (1472), and
  QQQ (1363) at `fixed_rate@1000ms`. Apple/AAPLX/AAPLON still need entitlement.
  The trial lasts 14 days according to the account screen; expiry is not hidden
  by a synthetic fallback. Keys remain server-side.
- Hosted Hermes `/v1/models` and `/p/default/v1/models` redirect to dashboard login.
  Website chat has no verified public agent API endpoint yet.

## Required before claiming the funded-vault loop

An executable strategy proposal and its decoded instructions; an approved
mandate bound to a funded isolated vault; a configured venue adapter with live
quotes; exact raw-unit checks; simulation of the actual transaction; a restricted
signer with replay protection; confirmation and settlement receipts; and a return
transaction to the DAO. Clawpump execution, PreStocks execution, x402 on Solana,
TEE operation, and OMP upgrades are not implemented in this repository.

Suggested accurate submission sentence:

> The Stocklana prototype reads our deployed Solana DAO, reads five live Pyth trial feeds,
> compares BTC/WBTC reference prices, and demonstrates deterministic mandate and risk checks
> through an inspectable policy rehearsal. DAO-funded Solana execution and
> settlement are the next integration milestone; historical live execution is
> demonstrated separately by our Robinhood Chain prototype.

Pyth documentation: <https://docs.pyth.network/price-feeds/pro/api/rest>.
Hermes API documentation: <https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>.
