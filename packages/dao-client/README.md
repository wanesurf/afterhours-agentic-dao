# DAO client

Typed access to Realms proposals, strategy mandates, treasury accounts, and
upgrade approvals. Consumers must read finalized onchain state rather than trust
an agent-supplied description of a proposal.

`src/deployed-dao.ts` currently verifies the known Realm, governance, community
mint, and council mint account owners against finalized Solana mainnet state.
The community mint uses Token-2022; holder balance checks must use that program.
This read verifies account identity only. It does not decode governance config,
proposal rights, voting weight, or approved strategy instructions.

`src/governance.ts` also decodes the known governance account's voting settings,
proposal thresholds, native treasury balance, and proposal lifecycle states.
It validates program ownership, discriminators, Realm binding, and voting mints
using finalized reads. Proposal instruction counts are displayed, but their
effects are not compiled or approved as executable strategy mandates.
