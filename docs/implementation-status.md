# Hackathon implementation status

## Website deployment

The Roman landing page and public chat server are live at
https://afterhouragent.xyz (Railway `afterhours-web`).
The migration app remains at https://migration.afterhouragent.xyz.
Canonical-domain HTTPS and anonymous sessions passed live checks.
Page, banner, health, and secure anonymous-session checks passed on 2026-09-25.
The Hermes API is not yet reachable; live replies remain explicitly unavailable.
The local market demo uses live Pyth trial data. Production activation awaits
approval to store the Pyth key on Railway. The GitHub repository is private.

## Integrated demo (2026-09-25)

`/demo` now reads the actual governance settings and proposals, displays live data
availability, and runs six explicitly synthetic policy scenarios. It offers
JSON decision records with reproducible content hashes and never grants execution
authority. `pnpm demo:check` exercises the HTTP flow and reports blocked external
integrations separately. See [demo runbook](demo-runbook.md).

The configured key successfully reads BTC, WBTC, TSLA, VOO, and QQQ. The default
`free-trial` profile compares only BTC/WBTC and displays the three equities/ETFs as
context. The `apple` profile remains available but needs additional entitlement.
Every signal is non-executable; no WBTC Solana venue has been verified.
The latest finalized read found only the completed council metadata proposal;
there is no approved trading strategy. Full vault funding, execution, and returns
remain unimplemented. The new demo is deployed at https://afterhouragent.xyz/demo; production governance
and rehearsal requests passed. GitHub source remains private.

## Implemented

- Read-only Arbitrage MCP with `get_market_state` and `scan_opportunities`.
- Pyth Pro REST parsing for the five trial feeds plus optional AAPL/AAPLX/AAPLON, with feed-ID, freshness,
  session, confidence, and publisher checks. The trial feed IDs were verified from authenticated live responses.
- AAPLX/AAPL, AAPLON/AAPL, and AAPLON/AAPLX basis calculations. Signals remain
  non-executable until executable venue quotes and a governed mandate exist.
- Deterministic execution preflight for mandate dates, pause state, allowlists,
  trade size, vault exposure, slippage, net profit, and quote freshness.
- Proposal review and portal submit checks compare raw Realms proposal weight
  with integer arithmetic, including balances above JavaScript's safe integer.
- A read-only market monitor displays feed quality, configured basis readings,
  and candidate discounts. It uses explicitly labeled sample prices when no
  Pyth Pro token is configured.
- Roman-inspired landing page with the supplied assembly banner, local fonts,
  responsive layouts, and no automatic animation.
- Open agent chat with anonymous browser sessions; no wallet, signature, or
  token ownership requirement. Governance eligibility is separate.
- Read-only chat UI and a tool-free Hermes API proxy, browser-session isolation,
  bounded history, expiry, rate limits, and origin checks. The actual hosted
  main agent API is not connected yet; the UI reports setup pending.
- Automated tests, including MCP, anonymous HTTP chat/session isolation,
  rate limits, Hermes tool isolation, and optional holder-auth helper tests.
- Read-only DAO account verification on finalized Solana mainnet: Realm,
  governance account, $AFTERHOURS community mint (Token-2022), and council
  mint. The web monitor links to the deployed Realm and shows the verification
  slot. This verifies account identities, not voting rules or mandate authority.

## Next vertical slice

1. Connect a version-pinned Hummingbot Gateway quote endpoint and normalize its
   actual response into exact token amounts, expected receive amounts, fees,
   impact, route, and quote expiry. No quote may be supplied by Hermes as
   authoritative evidence.
2. Compare those executable quotes with Pyth reference prices. Separate a
   one-sided convergence position from a two-legged or hedged arbitrage trade.
3. Read the finalized Realms mandate and current vault exposure server-side;
   bind them to the quote and exact proposed instructions.
4. Simulate the transaction, verify the instructions are unchanged, and add an
   idempotent signer path and confirmed transaction receipts. Use exact raw-unit
   arithmetic before the signer can be enabled.
5. Build the web view for mandate, price evidence, quote, simulation, and
   public execution receipts. Connect and verify the main read-only Hermes API.

## Configuration needed for a live demonstration

- Main read-only agent API URL/key (`HERMES_API_URL`, `HERMES_API_KEY`), with no
  tools on the API platform. No separate holder profile is required.
  The hosted dashboard is not the API endpoint. See `apps/web/README.md`.

- The configured server-side Pyth token covers the trial feeds. Additional Apple
  entitlements are needed only to enable the original stock strategy.
- The Hummingbot API/Gateway version and endpoint, plus local credentials in a
  secret store. Its live OpenAPI schema is authoritative for quote fields.
- A production Solana RPC URL, strategy-vault address, and a controlled test
  wallet. The deployed Realm, governance account, and token mint are identified
  in `.env.example`. Keep wallet secrets out of this repository.

## Deployed governance decision

The Realm is [AfterhoursAgenticDAO](https://v2.realms.today/dao/HLbzfAQP4b5oFBh8CeQ6DQSX1zr8kjjejxuywU2yYeCK)
on Solana mainnet. Its community mint is the Token-2022 $AFTERHOURS mint.
The visible “Verify DAO Metadata” proposal is a **Multi-sig Vote Type** proposal;
the Realm also displays a council. Confirm the intended holder voting path and
onchain proposal thresholds before enabling the proposal builder or any strategy
execution. The public account check does not establish those permissions.

The current code cannot execute trades. Do not connect a production signer
until the remaining checks and exact arithmetic are implemented and verified.
