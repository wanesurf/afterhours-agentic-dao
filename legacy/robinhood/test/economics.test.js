import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'viem';
import { estimateRoundTripGasUsdg, projectedNetProfitAtClose } from '../src/economics.js';

const buyUsdg = parseUnits('5', 6);
const oracleFeeUsdg = parseUnits('0.05', 6);
const gasUsdg = parseUnits('0.07', 6);
const settings = { referenceClose: 100, buyUsdg, oracleFeeUsdg, gasUsdg,
  exitCostBufferPct: 0.3, minExpectedNetProfitPct: 1 };

test('weak discount cannot pay for the Oracle and a 1% net minimum', () => {
  const minOut = parseUnits((5 / 99.6 * 0.9975).toFixed(18), 18);
  const result = projectedNetProfitAtClose({ ...settings, minOut });
  assert.equal(result.passes, false);
  assert.ok(result.estimatedNetProfitUsdg < 0n);
  assert.equal(result.minimumProfitUsdg, parseUnits('0.05', 6));
});

test('strong discount clears the Oracle, exit, gas, and 1% net minimum', () => {
  const minOut = parseUnits((5 / 95 * 0.9975).toFixed(18), 18);
  const result = projectedNetProfitAtClose({ ...settings, minOut });
  assert.equal(result.passes, true);
  assert.ok(result.estimatedNetProfitUsdg >= result.minimumProfitUsdg);
  assert.equal(projectedNetProfitAtClose({ ...settings, minOut,
    referenceClose: 96 }).passes, false);
});

test('zero disables the profit gate even when the modeled return is negative', () => {
  const minOut = parseUnits((5 / 99.6 * 0.9975).toFixed(18), 18);
  const result = projectedNetProfitAtClose({ ...settings, minOut, minExpectedNetProfitPct: 0 });
  assert.equal(result.minimumProfitUsdg, 0n);
  assert.ok(result.estimatedNetProfitUsdg < 0n);
  assert.equal(result.passes, true);
});

test('round-trip gas is valued from a fresh approved ETH/USDG quote', async () => {
  const gas = await estimateRoundTripGasUsdg(250_000, {
    client: { getGasPrice: async () => 1_000_000_000n },
    quote: async amount => {
      assert.equal(amount, parseUnits('10', 6));
      return { amountOut: parseEther('0.005') };
    },
  });
  assert.equal(gas, parseUnits('1', 6));
  await assert.rejects(() => estimateRoundTripGasUsdg(250_000, {
    client: { getGasPrice: async () => 1_000_000_000n },
    quote: async () => ({ amountOut: 0n }),
  }), /unavailable/);
});
