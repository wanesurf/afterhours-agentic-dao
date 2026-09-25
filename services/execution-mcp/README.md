# Afterhours Execution MCP

The Execution MCP is the planned sole route to the delegated strategy signer.
It must reload the active finalized Realms mandate for every state-changing
request, read exposure from the strategy vault, validate the complete plan,
simulate exact instructions, and record the result.

The implemented `validateTrade` function is a deterministic **preflight check**.
It checks mandate dates and pause state, approved symbols and venues, trade size,
vault exposure, slippage, net profit, and quote expiry/age. It rejects invalid
numeric inputs and caps mandate quote age at 10 seconds. This function does not
read Realms, verify who supplied the vault state or quote, simulate a Solana
transaction, or sign anything. USD floating-point inputs must be replaced with
exact token/raw-unit arithmetic before authorizing production transactions.

Planned tools:

- `simulate_approved_trade`
- `execute_approved_trade`
- `get_execution_receipt`
- `emergency_stop`

A successful agent analysis does not authorize execution by itself.
