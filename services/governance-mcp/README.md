# Governance MCP

A custom read and drafting interface over Realms, the Afterhours strategy
registry, and DAO treasury state.

## Read tools

- `get_realm`
- `list_proposals`
- `get_proposal`
- `get_proposal_transactions`
- `get_active_mandate`
- `get_treasury_balances`
- `get_voting_power`
- `get_upgrade_history`

## Draft tools

- `draft_strategy_proposal`
- `validate_proposal_draft`
- `build_unsigned_proposal`

Draft tools return structured data and unsigned transactions. They do not cast a
vote, sign off a proposal, execute a proposal transaction, or hold a governance
key. The web wallet signs proposal creation directly.
