import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, parseUnits } from 'viem';
import { USDG } from '../src/config.js';
import { POOLS } from '../src/v3.js';
import { actualFill } from '../src/exit.js';

const wallet = '0x141B4102b22457D397EBeB69fa6ea052F604C9b1';
const filler = '0x1111111111111111111111111111111111111111';
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const amount = parseUnits('5.5', 18);
const floor = parseUnits('1800', 6);
const pending = { amount: amount.toString(), floorUsdg: floor.toString() };
const settlement = { tokenIn: POOLS.AAPL.token, tokenOut: USDG,
  amountIn: amount.toString(), amountOut: (floor + 1n).toString() };

function log(address, from, to, value) {
  return { address, topics: encodeEventTopics({ abi: [transfer], eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}

test('a filled order is recorded only when the receipt spends the exact position and pays the floor to the wallet', () => {
  const receipt = { status: 'success', logs: [
    log(POOLS.AAPL.token, wallet, filler, amount),
    log(USDG, filler, wallet, floor + 1n),
  ] };
  assert.equal(actualFill(receipt, pending, 'AAPL', wallet, settlement), floor + 1n);
  assert.equal(actualFill({ ...receipt, logs: [receipt.logs[0],
    log(USDG, filler, wallet, floor + 100n)] }, pending, 'AAPL', wallet, settlement), floor + 1n,
  'a batched transaction must count only this order settlement');
  assert.throws(() => actualFill({ ...receipt, logs: [receipt.logs[0],
    log(USDG, filler, wallet, floor - 1n)] }, pending, 'AAPL', wallet, settlement), /does not match/);
  assert.throws(() => actualFill({ ...receipt, logs: [
    log(POOLS.AAPL.token, filler, wallet, amount), receipt.logs[1],
  ] }, pending, 'AAPL', wallet, settlement), /does not match/);
  assert.throws(() => actualFill(receipt, pending, 'AAPL', wallet,
    { ...settlement, amountOut: (floor - 1n).toString() }), /treasury target/);
  assert.throws(() => actualFill({ ...receipt, status: 'reverted' }, pending, 'AAPL', wallet, settlement), /reverted/);
});
