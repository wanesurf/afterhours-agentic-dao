import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem } from 'viem';
import { AFTERHOURS, USDG } from '../src/config.js';
import { AFTERHOURS_POOL_ID, buybackSwapActions, verifiedBurnReceipt, verifiedSwapReceipt } from '../src/buyback.js';

const wallet = '0x141B4102b22457D397EBeB69fa6ea052F604C9b1';
const pool = '0x1111111111111111111111111111111111111111';
const zero = '0x0000000000000000000000000000000000000000';
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
function log(token, from, to, value) {
  return { address: token, topics: encodeEventTopics({ abi: [transfer], eventName: 'Transfer',
    args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}

test('buyback receipt verifies exact USDG debit and bought tokens before a burn', () => {
  const receipt = { status: 'success', logs: [
    log(USDG, wallet, pool, 5_000000n),
    log(AFTERHOURS, pool, wallet, 20_000000000000000000000n),
  ] };
  assert.equal(verifiedSwapReceipt(receipt, wallet, 5_000000n,
    19_000000000000000000000n), 20_000000000000000000000n);
  assert.throws(() => verifiedSwapReceipt(receipt, wallet, 4_000000n, 1n), /does not match/);
  assert.throws(() => verifiedSwapReceipt(receipt, wallet, 5_000000n,
    21_000000000000000000000n), /does not match/);
  assert.throws(() => verifiedSwapReceipt({ ...receipt, status: 'reverted' }, wallet,
    5_000000n, 1n), /reverted/);
});

test('burn receipt must send the purchased amount to zero', () => {
  const receipt = { status: 'success', logs: [
    log(AFTERHOURS, wallet, zero, 20_000000000000000000000n),
  ] };
  assert.equal(verifiedBurnReceipt(receipt, wallet, 20_000000000000000000000n),
    20_000000000000000000000n);
  assert.throws(() => verifiedBurnReceipt({ ...receipt, logs: [
    log(AFTERHOURS, wallet, pool, 20_000000000000000000000n),
  ] }, wallet, 20_000000000000000000000n), /did not destroy/);
});

test('buyback encodes the pinned V4 route with the current single-hop fields', () => {
  const key = { currency0: USDG, currency1: AFTERHOURS, fee: 0,
    tickSpacing: 200, hooks: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' };
  assert.equal(keccak256(encodeAbiParameters([{ type: 'tuple', components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ] }], [key])), AFTERHOURS_POOL_ID);
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }],
    buybackSwapActions(key, 10_000000n, 100n));
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
  assert.equal(swap.amountIn, 10_000000n);
  assert.equal(swap.amountOutMinimum, 100n);
  assert.equal(swap.minHopPriceX36, 0n);
  assert.equal(swap.poolKey.hooks.toLowerCase(), key.hooks.toLowerCase());
});
