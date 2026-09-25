import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAbiParameters } from 'viem';
import { CHAIN_ID, USDG } from '../src/config.js';
import { GAS_POOL_ID, GAS_POOL_KEY, gasPoolId, gasSwapInput, quoteGasRefill } from '../src/gas-refill.js';
import { Ledger } from '../src/ledger.js';

test('gas refill is pinned to the selected Uniswap v4 ETH/USDG pool', async () => {
  assert.equal(gasPoolId(), GAS_POOL_ID);
  let call;
  const quote = await quoteGasRefill(10_000000n, {
    getChainId: async () => CHAIN_ID,
    simulateContract: async request => { call = request; return { result: [4_000_000_000_000_000n, 50_000n] }; },
  });
  assert.equal(call.args[0].poolKey.currency1, USDG);
  assert.equal(call.args[0].poolKey.hooks, GAS_POOL_KEY.hooks);
  assert.equal(call.args[0].zeroForOne, false);
  assert.equal(quote.amountOut, 4_000_000_000_000_000n);
  await assert.rejects(() => quoteGasRefill(10_000000n, { getChainId: async () => 1 }), /Wrong chain/);
});

test('refill calldata spends exact USDG and takes bounded native ETH', () => {
  const encoded = gasSwapInput(10_000000n, 3_900_000_000_000_000n);
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], encoded);
  assert.equal(actions, '0x060c0f');
  const [swap] = decodeAbiParameters([{ type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' },
    ] }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' },
    { name: 'hookData', type: 'bytes' },
  ] }], params[0]);
  assert.equal(swap.minHopPriceX36, 0n);
  assert.equal(swap.amountIn, 10_000000n);
  const [currency, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]);
  assert.equal(currency.toLowerCase(), USDG.toLowerCase());
  assert.equal(amount, 10_000000n);
  const [outCurrency, minOut] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]);
  assert.equal(outCurrency, GAS_POOL_KEY.currency0);
  assert.equal(minOut, 3_900_000_000_000_000n);
  assert.throws(() => gasSwapInput(101_000000n, 1n), /bounded/);
});

test('gas refills consume eligible claimed USDG within a separate daily cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gas-ledger-'));
  try {
    const path = join(directory, 'state.json');
    const address = '0x1111111111111111111111111111111111111111';
    const ledger = new Ledger(address, path);
    assert.equal(ledger.canGas(10_000000n, 30_000000n, 50_000000n), false);
    ledger.creditClaim(40_000000n, `0x${'a'.repeat(64)}`);
    for (let n = 0; n < 3; n++) ledger.reserve('gas', null, 10_000000n, 30_000000n, null, 40_000000n);
    const restarted = new Ledger(address, path);
    assert.equal(restarted.canGas(10_000000n, 30_000000n, 40_000000n), false);
    assert.equal(restarted.available(40_000000n), 10_000000n);
    assert.equal(restarted.state.gas, '30000000');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
