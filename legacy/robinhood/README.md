# Afterhours Agent — legacy Robinhood Chain

Imported into the Afterhours Agentic DAO repository on 2026-09-25.
This standalone Node/npm project powers the historical Robinhood Chain desk at
<https://rh.afterhouragent.xyz/>. It is separate from the new Solana services.
See [IMPORT.md](IMPORT.md) for source provenance, scope, and verification.

From the repository root:

```sh
npm ci --prefix legacy/robinhood
pnpm test:legacy
npm run build:web --prefix legacy/robinhood
# Optional local dashboard, with no watcher or trades:
PORT=8766 npm run preview:legacy
```

Run agent, contract, and deployment commands below from `legacy/robinhood`.
Use a separate local `.env`; no live credentials or spending ledgers are included.
The original working tree and deployed Robinhood service are unchanged by this import.

An autonomous, default read-only agent that pays the [After-Hours Oracle](https://afterhoursoracle.xyz/) through x402 and acquires eligible Robinhood Chain Stock Tokens. Its default funding source is **directly claimed Pons V2 creator fees in USDG**. A separate wallet-funded mode can spend an existing USDG balance up to an explicit total cap before a Pons token launches. It connects to the [After-Hours Dip Agent MCP server](https://glama.ai/mcp/servers/glabun002/after-hours-dip-agent) for wallet status. For trades, it quotes and swaps directly through the two operator-approved Uniswap v3 USDG pools. It does not use Ctrl rewards.

Its signal is a token's onchain price below the **last NYSE close**. That alone does not establish that a company is fundamentally undervalued. Stock Tokens are [tokenized debt securities, not shares of the underlying company](https://docs.robinhood.com/chain/stock-tokens/). Confirm jurisdictional eligibility before enabling trades.

For a step-by-step account of the live funding, screening, buying, and UniswapX order lifecycle, see [How the Afterhours agent works](AGENT.md).

[Robinhood says Stock Tokens are unavailable to residents of the United States, Canada, the United Kingdom, or Switzerland](https://robinhood.com/rhj/stocktokens/); other restrictions may apply. Live mode also requires `STOCK_TOKEN_ELIGIBILITY_CONFIRMED=true` after the operator has checked their jurisdictional eligibility. This flag is an operator acknowledgment, not a legal determination by the agent.

## How funds move

```text
Pons V2 token paired with USDG
  -> accrued creator fees -> Pons sweep -> USDG fee escrow
  -> dedicated creatorFeeRecipient wallet -> claimToken(USDG)
  -> 0.05 USDG x402 quote (subject to configured price cap)
  -> capped USDG -> Stock Token swap in an approved Uniswap v3 pool
  -> Stock Token held in that wallet
  -> optional UniswapX sale after opening; a filler settles to USDG
  -> optional gross-spread-funded $AFTERHOURS buyback and supply-reducing burn
```

The wallet needs a small initial amount of ETH for gas. With `AUTO_GAS_REFILL_ENABLED=true`, the agent can later swap eligible claimed USDG for native ETH through the pinned Uniswap v4 ETH/USDG pool when its gas balance falls below `MIN_GAS_ETH`. Each refill spends `GAS_REFILL_USDG`, subject to `MAX_GAS_REFILL_DAILY_USDG` and `GAS_REFILL_SLIPPAGE_PCT`; the swap needs ETH for its own approvals and execution. Fees do **not** become claimable until a [Pons sweep](https://docs.ponsfamily.com/v2#claiming-fees). This agent does not call sweeps or convert ETH paired rewards. It supports a **Pons V2 launch paired with USDG**, and verifies its factory record before any live claim or purchase. Creator fees are pooled by recipient and quote token in the escrow, so use a dedicated recipient address for the specific launch.

### Opening treasury exits

With `EXIT_ENABLED=true`, the agent checks AAPL and NVDA during the first `EXIT_WINDOW_MINUTES` after a fresh Oracle board confirms that the NYSE is open. It locks the last complete treasury valuation from before the opening bell. That value includes existing wallet cash, so the sell comparison uses the benchmark's stock value plus confirmed sale proceeds and fresh estimates for still-held stocks; later creator-fee claims cannot masquerade as trading profit. The locked benchmark appears in `/status.json` after the opening check. It reconstructs the exact stock quantities and USDG paid from the agent's confirmed Uniswap v3 purchase receipts, then requires those quantities, less its own confirmed exits, to equal the current wallet holdings. Transferred-in tokens, missing receipts, a stale or incomplete pre-open valuation, and uncertain order status stop the exit.

For each full position it requests a fresh Robinhood Chain **UniswapX V3** stock-to-USDG quote. Existing wallet USDG is already part of the treasury value: the signed worst-case proceeds, plus confirmed earlier sales and a fresh estimate of still-held stocks, must exceed the locked pre-open stock value by at least `EXIT_MIN_PROFIT_USDG`. The signed order must spend at most the held quantity and send USDG only to the agent wallet. Recorded acquisition costs remain in the sale ledger for realized-profit accounting, but do not set the sell target. An increase over the pre-open market estimate is not necessarily a realized profit after purchase, Oracle, and gas costs. The agent verifies the Permit2 signing witness against the quoted order. A qualifying quote may require an exact-size onchain token approval to Permit2; the agent then requotes before signing. It stores one pending order at a time before sending it to UniswapX, never retries an uncertain submission, and counts a fill only after twelve blocks and checking the order's own settled amount against the onchain stock debit and USDG credit. An unfilled order can expire. No sale is guaranteed at the opening bell.

The exit is off by default. Store the developer key as `UNISWAP_API_KEY` in Railway Variables; the existing `UNISWA_API_KEY` spelling is also recognized. While enabled and the NYSE is closed, the agent refreshes its read-only acquisition receipt cache in the background of each evaluation cycle so the opening check only needs recent blocks. `node scripts/preflight-uniswap-exit.js` requests quotes only and never signs or submits an order. `node scripts/preflight-exit-basis.js` rebuilds acquisition costs from read-only receipts. Use one Railway replica and retain `/app/.data` for pending orders. Set `EXIT_ENABLED=true` only when automatic approvals and qualifying order submissions are intended.

### Profit-funded buyback and burn

With `BUYBACK_ENABLED=true`, after all held Stock Tokens have sold and no exit order remains pending, the wallet agent uses **cumulative realized gross trading spread** to buy `$AFTERHOURS` from its verified Pons USDG pool and call the token's supply-reducing `burn` function. It subtracts verified acquisition cost and prior buyback spend from confirmed sale proceeds. Oracle payments and ETH gas remain separate expenses and do not reduce this allocation, so a buyback can occur despite an overall net loss. It retains at least 100 USDG cash, requires at least 1 USDG available, and caps a single buyback at 100 USDG. A trading loss must be recovered before another buyback. It verifies both the buy and burn onchain before recording completion in `/buybacks.json`. Existing wallet tokens are not burned. See [the agent mechanism](AGENT.md#profit-funded-buyback-and-burn) for receipt and recovery details.

This flow is operated by the current agent wallet. The DAO contracts are still local and do not govern its funds or approve its buyback policy.


### Wallet-funded trading before launch

Set `FUNDING_MODE=wallet` and `WALLET_TOTAL_BUDGET_USDG` to a positive total USDG cap. This mode does not require `PONS_TOKEN_ADDRESS`, does not claim creator fees, and uses the dedicated wallet's existing USDG only within that fixed cap and the Oracle daily limit. The total cap includes both buys and paid Oracle quotes. Depositing more USDG does not raise the cap. The first read-only cycle creates the private spending ledger on the persistent volume; live mode refuses to recreate a missing ledger or silently change its wallet or cap. Back up this ledger before enabling paid actions.

The first wallet-funded run used **50 USDG total**, **5 USDG per buy**, **no daily buy cap**, and an initial **0.50 USDG daily Oracle allowance**. The wallet must also hold ETH on Robinhood Chain for approvals, Oracle payments, and swaps. Wallet-funded trades are not Pons creator-fee spending; the public dashboard identifies the funding source. Once the direct USDG-paired Pons token is live, the agent verifies the factory's creator-fee recipient and migrates the private spending ledger before claiming rewards. The migration archives the original wallet ledger, starts creator-fee credit at zero, and preserves today's Oracle usage history. Existing wallet USDG is never counted as creator revenue.

## Launch setup

1. Create a dedicated Robinhood Chain wallet and store its key securely outside this repository. Set `AGENT_PRIVATE_KEY` in a private environment or local `.env`, then run `npm run wallet` to show the public address. **Do not share the private key.** The address will hold claimed rewards and purchased Stock Tokens.
2. Run `npm run preflight` to check live Pons launch access, USDG pair approval, economics, and the ETH launch fee. If the launching wallet differs from the reward recipient, set `PONS_LAUNCHER_ADDRESS` first. At [Pons V2](https://docs.ponsfamily.com/v2), launch a token with `pairToken = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (USDG) and `creatorFeeRecipient` set to the address from step 1. Launch access can be restricted.
3. After launch, set `PONS_TOKEN_ADDRESS` to the new token's contract address. The agent checks that the Pons V2 factory reports the same recipient and USDG quote asset. Fund the agent wallet with a little ETH for claims and swap gas. In creator-fee mode, no USDG deposit is counted as earned revenue.
4. Wait for creator fees to be swept into the escrow and check the read-only board. Only then decide whether to set `LIVE_TRADING=true`.

The deployed [AfterHours Agent ($AFTERHOURS) token](https://robinhoodchain.blockscout.com/token/0x6918EcC39996DAE959FBb7aAb1F6e926f285eBd4) is configured in the Railway service as `PONS_TOKEN_ADDRESS`. Its factory record reports a USDG pair and the agent wallet as the creator-fee recipient.

## DAO governance contracts

The local [governance contracts](contracts/README.md) use an OpenZeppelin 1:1 voting wrapper, Governor, Timelock, and a transitional treasury. Holders wrap `$AFTERHOURS`, delegate voting power, and vote from timestamped balance snapshots; the wrapper has no yield or minimum lock and can be redeemed 1:1. The treasury starts paused under an explicit two-step administrator, supports a checked successor migration, and rotates the Pons creator-fee recipient during that migration. Ownership can move to the Timelock when the DAO executor is ready. The contracts are implemented and tested locally but are not deployed and do not control the current agent wallet, creator-fee recipient, or funds.

### Launching through Clawpump

[Clawpump's Pons launch page](https://clawpump.tech/launch?platform=pons) and [partner API](https://clawpump.tech/developers) offer Pons launches. The API documents a `pairToken` field, so request **USDG explicitly**, plus a Robinhood Chain `payoutWallet`, token metadata, and an idempotency key. The public page requires login before its detailed launch form is visible; verify that the signed launch terms show USDG as the quote asset.

Clawpump [says its collector retains fee-collection authority](https://clawpump.tech/docs) and forwards an agent share to `payoutWallet`. That is a different revenue path from this agent's direct `claimToken(USDG)` flow. A Clawpump-launched token is **not yet compatible with live mode here**: the agent verifies that the Pons factory's `creatorFeeRecipient` is its own wallet and will stop if Clawpump instead owns that role. Do not enable trading on the assumption that a Clawpump payout is a direct Pons claim. To support Clawpump, we need its actual payout source, asset, and verifiable distribution record before crediting rewards to the spending ledger. The `npm run preflight` launch-access check applies to a direct Pons launching wallet, not necessarily Clawpump's launcher.

## Run

Requires Node.js 20+, Git, a Robinhood Chain RPC, and a securely managed private key for live mode.

```sh
npm install
npm run setup:upstream
cp .env.example .env
# edit .env locally; never commit it
npm run wallet
npm run preflight        # read-only Pons eligibility and USDG pair check
npm run once             # free board, read-only by default
npm run watch            # read-only polling
```

After launch, configure `PONS_TOKEN_ADDRESS`, ETH gas, a reliable `RPC_URL`, and `LIVE_TRADING=true` to allow claims, x402 payments and swaps. `npm run once` performs one cycle; `npm run watch` polls every `POLL_MINUTES`, without overlapping cycles. The live Railway service uses a one-minute interval. Stop the watcher before starting another process. The pinned upstream repository is installed under ignored `.runtime/`; its source is not redistributed here.

For this service's existing wallet-funded ledger, switch `FUNDING_MODE=creator-fees` and `MIGRATE_WALLET_TO_CREATOR_FEES=true` together only after verifying the token, USDG pair, and fee recipient onchain. The first creator-fee cycle retains a private copy of the old wallet ledger and records the funding transition on the public dashboard. The flag is idempotent for that recorded migration; it cannot migrate an unrelated ledger or count the old wallet deposit as earned revenue.

Settings in `.env.example` limit each trade (`BUY_USDG`), optional daily trade spending (`MAX_DAILY_USDG`), Oracle fees (`MAX_API_DAILY_USDG`, `MAX_API_FEE_USDG`), and the minimum discount and maximum executable price. `MAX_DAILY_USDG=0`, `MAX_BUYS_PER_DAY=0`, and `MAX_API_DAILY_USDG=0` remove the daily buy and Oracle allowance limits; each Oracle quote still has a 0.05 USDG maximum. A candidate must pass a fresh paid Oracle quote during closed NYSE hours. The agent checks every minute in the live service, obtains an executable quote for the configured 5 USDG buy size, and pays for only one shortlisted ticker at a time. It buys at most one per cycle. Only [AAPL/USDG](https://app.uniswap.org/explore/pools/robinhood/0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d) and [NVDA/USDG](https://app.uniswap.org/explore/pools/robinhood/0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3) are approved for screening and trading. Both are Uniswap v3 pools with a 0.05% pool fee; the agent verifies each pool's factory, tokens, and fee onchain before quoting or swapping.

The free Oracle board supplies the last NYSE close and market state. Its old v4 onchain price is ignored because it comes from a thin pool that does not represent the selected execution route. The approved v3 pool's 5 USDG quote must be at least 0.6% below the last close to become a candidate. Before paying the Oracle, the agent requotes the same pool and checks the price. It also estimates the value of the minimum token output at the last close, then subtracts the maximum Oracle fee, a 0.3% sell-side allowance, and round-trip gas priced through the approved ETH/USDG pool. Each leg reserves 250,000 gas for approval and swap. The projected net return is logged for transparency but does not block the paid Oracle quote or buy when `MIN_EXPECTED_NET_PROFIT_PCT=0`, even if the estimate is negative. These values are configurable with `MIN_EXPECTED_NET_PROFIT_PCT`, `EXIT_COST_BUFFER_PCT`, and `ESTIMATED_GAS_UNITS_PER_LEG`. A fresh paid Oracle response confirms the close, market state, source, and timestamp. Before buying, the agent requotes the v3 pool, logs a final nonblocking return estimate using the actual Oracle fee and the earlier gas estimate when available, rejects a route that moved more than 1% above the initial quote or fails the 0.6% below-close execution floor, and enforces 0.25% maximum quote slippage in the swap transaction. The profit estimate assumes convergence to the last close; it is not guaranteed. A quote can change before inclusion, so a swap may revert without a purchase.

The private `.data/state.json` ledger credits only verified USDG transfers from the configured Pons escrow after a claim. Funds transferred directly to the wallet remain outside its budget. **Back up the ledger** along with wallet operations; deleting it safely loses spending authority over prior claims. Every oracle payment and proposed trade is reserved before external calls. Uncertain failures remain charged to prevent repeat spending; reconcile the chain and ledger manually before adjusting them. The file and process lock assume **one local agent process on one machine**, with no other signer spending from the wallet. If a crash leaves `.data/agent.lock`, inspect the process and ledger before removing the lock.

Approval transactions authorize only the configured buy amount of USDG to Uniswap's Robinhood Chain SwapRouter02. The swap minimum output satisfies both slippage and the configured price versus the NYSE close. Market data can be delayed or inaccurate, liquidity can disappear, and stock token prices can diverge sharply from securities markets. Verify the token contracts and legal availability for your location independently.

The pinned upstream dependency installation currently reports npm security advisories (including high severity transitive dependencies). Review and isolate that runtime before supplying a funded live wallet; the default read-only board does not load it.

## Host on Railway

The `Dockerfile` builds the pinned MCP dependency and starts the five-minute watcher. Railway can deploy this directory directly with its CLI; the directory does not need to be a Git repository. Keep `LIVE_TRADING=false` for the initial deployment. The service listens on Railway's `PORT` and serves a public dashboard at `/`, machine-readable status at `/status.json`, paginated decisions at `/activity.json`, per-ticker executable pool quotes at `/history.json?ticker=AAPL&hours=24`, and a liveness endpoint at `/healthz`. A successful status check reports that the watcher completed a market-data cycle, not that a stock was bought.

The initial read-only deployment is live at [agent-production-02cc.up.railway.app](https://agent-production-02cc.up.railway.app/). Its [Railway service](https://railway.com/project/3e37d0b8-f618-4e08-aa6a-20b68cb8da32/service/0680402e-9c8d-4a7c-a643-6caefc1276dd) has a public domain targeting port 8080, `/healthz` as the deployment healthcheck, and one volume mounted at `/app/.data`.

Generate a public domain for the service in Railway's Networking settings and configure `/healthz` as its deployment healthcheck. To retain the private spending ledger across restarts, attach one persistent volume at `/app/.data` before enabling live mode. Run one replica only. Railway live mode refuses to start if the volume is missing. Set `AGENT_PRIVATE_KEY` as a sealed Railway variable, never in the repository; `AGENT_PUBLIC_ADDRESS` may be set to the corresponding public address for the status page. `PONS_TOKEN_ADDRESS` and `LIVE_TRADING=true` belong in Railway variables only after the direct Pons USDG launch is verified. The public page links to the wallet and token explorer records when configured.

The dashboard shows the most recent screen, each cycle's decisions, the configured spending rules, creator-fee totals, and the agent wallet's USDG, AAPL and NVDA balances. The portfolio estimates each stock position's full-balance sale value through its approved Uniswap v3 USDG pool and excludes ETH gas. If a sell quote fails, the token balance remains visible while the total valuation is withheld. Beside the treasury value, estimated gross trading P/L adds the current approved-pool sale estimates for held Stock Tokens and confirmed sale proceeds, then subtracts acquisition costs verified from onchain buy receipts. It excludes Oracle and gas costs and is not an executable UniswapX quote or realized profit for unsold positions. When all positions are sold, it equals the confirmed exits' realized gross trading spread. The figure is withheld while a sale is pending or its acquisition index is unavailable. The public buy counter can differ from verified acquisition costs because it begins with the dashboard's own event history. Wallet balances are separate from the private trading cap. Its chart contains only timestamped 5 USDG quotes obtained by this agent from the approved pools. Old Oracle spot observations are cleared from the chart when this route version starts, so different price sources are not mixed. It starts with one point and grows as checks occur; it is not a market-wide historical feed. The public journal retains the most recent 5,000 events and 400 board snapshots in `/app/.data/public-activity.json`. These counts and totals begin when the dashboard version first runs. The private spending ledger remains separate.

The public capital flow separately counts confirmed USDG-to-ETH gas refills, and the decision log links each confirmed refill transaction.

## Ask the agent on the website

The dashboard's **Ask the agent** panel accepts questions about public holdings, the last recorded AAPL/NVDA pool quotes, creator fees, trading rules, governance status, and completed buybacks. It calls `POST /chat.json`; it cannot sign transactions, change policy, or access wallet keys. The AI receives a concise description of the implemented agent, current public status and receipts, and the previous ten conversation turns so it can answer follow-up questions in context.

To enable replies, set `WEB_CHAT_ENABLED=true` and `OPENAI_API_KEY` in the Railway service's private Variables. `WEB_CHAT_MODEL` optionally overrides the default `gpt-4o-mini`. The server sends selected public facts and the visitor's question and recent chat turns to OpenAI with `store: false`. It accepts at most 500 characters per question and ten prior turns, allows six questions per client address per ten minutes, handles two requests at once, and reserves at most 500 AI calls per UTC day in `/app/.data/web-chat.json`. When AI is unavailable or the daily budget is spent, the chat reports that it cannot answer; it does not substitute a canned reply. Conversations persist only in the browser tab's session storage and are not saved to the public activity feed. Visitors should not enter private keys or personal information.

## Optional X account publishing

X account registration happens through [X signup](https://help.x.com/en/using-x/create-x-account), not through the posting API. Create a separate bot profile with its own verified email or phone. Identify it as automated in the profile. X's [automated account label](https://help.x.com/en/using-x/automated-account-labels) is a test feature and links the bot to the human-run account managing it. Keep publishing disabled until that label and link are available and confirmed.

Sign in to the [X Developer Console](https://console.x.com/) as the bot account, accept the Developer Agreement, and create a new app for this personal bot. Give the app posting/write access. Save the app's API Key and Secret plus its user Access Token and Secret. The access token must act as the bot account. If an app is instead owned by your personal account, authorizing the bot requires a separate user OAuth flow; simply using the app owner's access token would post from the owner. See [X getting access](https://docs.x.com/x-api/getting-started/getting-access) and [authentication](https://docs.x.com/fundamentals/authentication/overview). An app-only bearer token is insufficient for posting as the bot.

In Railway's service **Variables**, add `X_ACCOUNT_HANDLE`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, and `X_ACCESS_TOKEN_SECRET`. Set `X_AUTOMATED_LABEL_CONFIRMED=true` only after the bot profile actually displays the label and the linked human account. Then set `X_POSTING_ENABLED=true`. Leave `LIVE_TRADING=false` until the separate onchain launch and wallet are ready. X publishing requires the existing volume at `/app/.data`, one service replica, and an X API plan or credits that permits posting. X and OpenAI API bills are separate from Pons creator rewards and the Oracle's USDG payments.

Before the first post in a process, the agent calls X's authenticated `/2/users/me` endpoint and checks that the access token's username equals `X_ACCOUNT_HANDLE`. A mismatched token blocks posting. This verification is an X API read and may have its own usage charge.

For optional AI wording, create an API key in the [OpenAI API dashboard](https://developers.openai.com/api/docs/quickstart) and save it in Railway as `OPENAI_API_KEY`; `OPENAI_MODEL` defaults to `gpt-4o-mini`. The key never signs in to X and never decides whether to trade. It drafts a short neutral opening for the confirmed buy, using only its verified ticker and USDG amount. Code validates the opening and appends the holdings, transaction hash, Stock Token disclosure, and site URL from trusted data. If an AI request fails or its draft fails validation, the agent uses a factual local receipt. Each buy post includes the wallet's onchain Stock Token holdings, USDG balance, swap transaction, and public dashboard URL from a portfolio refresh after the swap. If that refresh is unavailable, the buy post waits for a valid snapshot.

With `X_BUYS_PER_POST=10` (the default), X receives one buy receipt after every ten newly confirmed purchases. The receipt covers the tenth buy and shows the current holdings. The count starts at the total already recorded when this setting first starts, and its progress persists across Railway restarts. Each UniswapX sale gets a separate post only after its fill is confirmed onchain and saved in the exit ledger. The sale post uses actual USDG proceeds and verified acquisition cost to report gross trading profit or loss before Oracle and gas, with the fill transaction hash. Oracle payments, routine market recaps, and DEX Screener profile announcements do not create separate X posts in this mode. `X_BUYS_PER_POST=0` restores the legacy per-event posting policy. `X_MAX_POSTS_PER_DAY` still caps posting attempts (default 5; set `0` for no application daily cap), and `X_POST_EVENTS_AFTER` can exclude older transaction events. The agent does not reply to users.

Successful X posts appear as links in the public activity feed. Posting attempts are reserved in `/app/.data/x-posting.json` before contacting X to prevent duplicate posts after timeouts or restarts. A result without a confirmed post ID is flagged for manual review and never retried automatically. A definitive X HTTP 403 rejection consumes that ten-buy milestone; the next attempt waits for ten further confirmed buys. For a confirmed sale only, an explicit daily-post-limit rejection (X code 185) is retried once on each later ET day until accepted; other rejections are left for review. Existing rejected and previously skipped buy events are not replayed. AI wording does not override X access restrictions. `X_MAX_POSTS_PER_DAY=0` removes only this agent's cap; X's [account limits](https://help.x.com/en/rules-and-policies/x-limits) and [automation rules](https://help.x.com/en/rules-and-policies/x-automation) still apply. Use Railway Variables or a local ignored `.env` for keys, never the repository or chat.

In legacy per-event mode (`X_BUYS_PER_POST=0`), `DEXSCREENER_PROFILE_WATCH_ENABLED=true` checks DEX Screener's public paid-order API and token-pair API once per cycle for `PONS_TOKEN_ADDRESS`. It posts one X announcement only after a `tokenProfile` order has a payment timestamp and `approved` status, and the public token page displays the agent website, X account, and image. Some finalized Robinhood orders do not appear in the public orders API; after verifying a finalized order in the marketplace account, the operator can set `DEXSCREENER_APPROVED_ORDER_ID` to that order's numeric ID. The agent then uses that confirmation plus the public profile check. This watch makes only read-only GET requests to DEX Screener; it never submits an order or payment. The announcement says “Enhanced Token Info is live,” not that DEX Screener audited the token. The post is deduplicated in the existing persistent X state.

Dashboard events are self-reported. Its check timestamps and a reachable HTTPS endpoint show recent operation; Blockscout transaction links provide independent evidence of claims, Oracle payments, and purchases once live actions are enabled. A Railway healthcheck runs at deployment time and is not continuous monitoring, so use a separate uptime monitor if continuous outage alerts are needed.

**Sources:** [Pons V2 launch, USDG pairing, fees and escrow](https://docs.ponsfamily.com/v2); [Robinhood Chain Stock Tokens and trading limitations](https://docs.robinhood.com/chain/stock-tokens/); [upstream MCP implementation](https://github.com/glabun002/after-hours-dip-agent).
