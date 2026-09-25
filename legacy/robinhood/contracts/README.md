# Afterhours governance contracts

**Status:** implemented and tested locally. These contracts are not deployed and do not control the current agent wallet, creator-fee recipient, or any funds.

## Components

- `AfterhoursVotes` wraps the deployed `$AFTERHOURS` token 1:1 as `vAFTERHOURS`. It is freely redeemable and has no yield or minimum lock. Holders must delegate voting power to themselves or another account.
- `AfterhoursGovernor` uses OpenZeppelin Governor with simple For/Against/Abstain counting, a token-supply quorum, governance-controlled settings, and Timelock execution.
- `TimelockController` is deployed directly from OpenZeppelin. The deployment script grants proposal and cancellation rights to the Governor, opens execution to any caller after the delay, and removes the deployment wallet's administrative role.
- `AfterhoursTreasury` is a paused transitional custody and Pons creator-fee collector. Its temporary administrator can migrate to a predeclared successor with the same factory, escrow, launched token, quote token, and owner. Migration claims accrued USDG, atomically changes the Pons creator-fee recipient, moves USDG, listed Stock Tokens, and native ETH, and retires the predecessor. Late balances can be forwarded after migration.

Voting checkpoints use timestamps. A holder's voting power for a proposal is the delegated `vAFTERHOURS` balance at the proposal snapshot. Tokens acquired after that snapshot do not count for that proposal. A holder may unwrap after the snapshot without changing the recorded voting power for that proposal.

## Commands

```bash
npm run contracts:fmt
npm run contracts:build
npm run contracts:test
```

The tests cover 1:1 wrapping and redemption, explicit delegation, snapshot voting, a full proposal lifecycle, Timelock execution, removal of deployment-wallet administration, exact creator-fee claims, checked treasury migration, Pons recipient rotation, late-balance forwarding, and two-step treasury administration.

The fork suite checks the deployed Robinhood Chain Pons factory, fee escrow, USDG, `$AFTERHOURS`, and AAPL contracts through a disposable local Anvil fork. Start Anvil separately, then point the test at that local endpoint:

```bash
anvil --fork-url "$ROBINHOOD_MAINNET_RPC_URL" --chain-id 4663 --port 8766
ROBINHOOD_FORK_RPC_URL=http://127.0.0.1:8766 npm run contracts:test:fork
```

The fork tests impersonate the current creator-fee recipient only inside Anvil. They verify the live factory's authorization, perform the creator-fee cutover, deploy a checked successor, migrate fork-only USDG, AAPL, and native ETH, and confirm the factory now identifies the successor. They never broadcast to Robinhood Chain.

## Deployment

Compile first, then provide every governance parameter explicitly:

```bash
npm run contracts:build
DEPLOY_GOVERNANCE_CONFIRM=DEPLOY_AFTERHOURS_GOVERNANCE npm run deploy:governance
```

The script refuses to broadcast without the confirmation value. It uses `GOVERNANCE_DEPLOYER_PRIVATE_KEY`, never `AGENT_PRIVATE_KEY`, validates the RPC chain and token bytecode, configures Timelock roles, renounces deployment-wallet administration, and writes the public deployment record to `.runtime/governance-deployment.json`.

The treasury has a separate guarded deployment because deploying custody and enabling custody are different actions:

```bash
npm run contracts:build
DEPLOY_TREASURY_CONFIRM=DEPLOY_AFTERHOURS_TREASURY npm run deploy:treasury
```

`TREASURY_INITIAL_ADMIN_ADDRESS` is explicit. The deployment creates a paused treasury and verifies its Pons launch, factory, fee escrow, launched token, quote token, migration source, and owner. It does **not** change the live Pons creator-fee recipient or transfer any asset. Those actions require a separate reviewed cutover.

The temporary administrator is the treasury's OpenZeppelin `Ownable2Step` owner. There is no second administrator or hidden migration role. Moving ownership to the Timelock removes the operator's authority after the Timelock accepts ownership. Ownership cannot be renounced because doing so could strand migration and late-balance recovery.

Treasury migration follows the Pons lottery pattern but uses the token fee escrow used by this USDG-paired launch. The administrator must pause the predecessor and deploy the successor with `migrationSource` equal to the predecessor. `migrateTo` validates both contracts, claims accrued USDG, calls the Pons factory's `transferCreatorFeeRecipient`, transfers quote-token and explicitly listed ERC-20 balances plus native ETH, and requires the successor to accept in the same transaction. The transaction reverts as a unit if any validation, transfer, or acceptance fails. A generic fee-recipient setter is intentionally omitted because redirecting fees without retiring and moving custody could orphan treasury assets.

Before any deployment, holders must approve the voting delay, voting period, proposal threshold, quorum, and Timelock delay. The exact contracts and deployment sequence require independent security review before receiving treasury authority.

## Current boundary

This implementation establishes voting, delayed execution, and a transitional treasury with checked migration. It does not yet implement the bounded DAO executor, realized-profit accounting, or `$AFTERHOURS` buyback and burn **contracts** described in `architecture.md`. The separate wallet agent can buy back and burn using its own verified profit ledger; DAO votes do not control that flow. The present agent still requires its signer to be the Pons recipient and trading wallet, so redirecting fees to the treasury before a DAO executor is implemented would stop its current flow.
