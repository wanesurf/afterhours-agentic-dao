import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buybackBudget, minimumTokens } from '../src/buyback-policy.js';

const inputs = { proceeds: '3354754473', acquisitionCost: '3325000000',
  alreadySpent: '0', cash: '3662939934', cashReserve: '100000000', maxPerTrade: '100000000' };

test('the confirmed 29.754473 USDG gross trading spread is fully allocated to buyback', () => {
  const budget = buybackBudget({ ...inputs, oracleSpend: '33450000', buyGasUsdg: '999999' });
  assert.equal(budget.grossSpread, 29_754_473n);
  assert.equal(budget.amount, 29_754_473n);
});

test('only cumulative gross spread remains spendable after earlier burns and cash reserve', () => {
  const budget = buybackBudget({ ...inputs, proceeds: '3500000000',
    alreadySpent: '25000000', cash: '115000000' });
  assert.equal(budget.grossSpread, 175_000_000n);
  assert.equal(budget.remaining, 150_000_000n);
  assert.equal(budget.amount, 15_000_000n, 'cash reserve is binding');
  assert.equal(buybackBudget({ ...inputs, proceeds: '3500000000',
    alreadySpent: '200000000' }).amount, 0n,
  'spent profit cannot be reused');
});

test('pool output minimum is bounded and input validation fails closed', () => {
  assert.equal(minimumTokens(1000n, 50), 995n);
  assert.throws(() => minimumTokens(0n, 50), /Invalid/);
  assert.throws(() => minimumTokens(1000n, 501), /Invalid/);
  assert.throws(() => buybackBudget({ ...inputs, cash: '-1' }), /Invalid/);
});
