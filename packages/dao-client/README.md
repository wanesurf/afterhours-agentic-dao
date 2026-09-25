# DAO client

Typed access to Realms proposals, strategy mandates, treasury accounts, and
upgrade approvals. Consumers must read finalized onchain state rather than trust
an agent-supplied description of a proposal.

`src/deployed-dao.ts` currently verifies the known Realm, governance, community
mint, and council mint account owners against finalized Solana mainnet state.
The community mint uses Token-2022; holder balance checks must use that program.
This read verifies account identity only. It does not decode governance config,
proposal rights, voting weight, or approved strategy instructions.
