const unsigned = /^\d+$/;

function atomic(value, name) {
  if (typeof value !== 'string' || !unsigned.test(value)) throw new Error(`Invalid ${name}`);
  return BigInt(value);
}

// Cumulative confirmed trading spread is proceeds less purchase cost. Oracle
// payments and ETH gas remain separately reported expenses, but the operator
// has directed that they do not reduce this buyback allocation.
export function buybackBudget({ proceeds, acquisitionCost,
  alreadySpent, cash, cashReserve, maxPerTrade }) {
  const values = Object.fromEntries(Object.entries({ proceeds, acquisitionCost,
    alreadySpent, cash, cashReserve, maxPerTrade })
    .map(([key, value]) => [key, atomic(value, key)]));
  const grossSpread = values.proceeds - values.acquisitionCost;
  const remaining = grossSpread > values.alreadySpent ? grossSpread - values.alreadySpent : 0n;
  const liquid = values.cash > values.cashReserve ? values.cash - values.cashReserve : 0n;
  const amount = [remaining, liquid, values.maxPerTrade].reduce((a, b) => a < b ? a : b);
  return { grossSpread, remaining, amount };
}

export function minimumTokens(quoted, slippageBps) {
  if (typeof quoted !== 'bigint' || quoted <= 0n ||
      !Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) {
    throw new Error('Invalid buyback quote or slippage');
  }
  return quoted * BigInt(10_000 - slippageBps) / 10_000n;
}
