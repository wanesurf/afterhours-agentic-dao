import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, parseUnits } from 'viem';

// This file runs in its own test worker. Exit and activity ledgers stay in a
// temporary directory, and all API and chain interactions are mocked.
const originalCwd = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'afterhours-exit-test-'));
process.chdir(directory);
const { config, USDG } = await import('../src/config.js');
const { POOLS } = await import('../src/v3.js');
const { PERMIT2, UNISWAPX_REACTOR } = await import('../src/exit-policy.js');
const { runExitCycle } = await import('../src/exit.js');
config.exitEnabled = true;
process.chdir(originalCwd);

const wallet = '0x141B4102b22457D397EBeB69fa6ea052F604C9b1';
const filler = '0x1111111111111111111111111111111111111111';
const amount = parseUnits('5.5', 18);
const output = parseUnits('1201', 6);
const orderId = '0x' + 'a'.repeat(64);
const transactionHash = '0x' + 'b'.repeat(64);
const opening = Date.parse('2026-09-21T13:30:05Z');
const board = { nyseOpenNow: true, asOf: new Date(opening).toISOString() };
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

function log(address, from, to, value) {
  return { address, topics: encodeEventTopics({ abi: [transfer], eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}

function fixtureQuote(minimumUsdg = '1200') {
  const input = { token: POOLS.AAPL.token, startAmount: amount.toString(), maxAmount: amount.toString(),
    adjustmentPerGweiBaseFee: '0', curve: { relativeBlocks: [80], relativeAmounts: ['0'] } };
  const receipt = { token: USDG, recipient: wallet,
    startAmount: parseUnits('1205', 6).toString(), minAmount: parseUnits(minimumUsdg, 6).toString(),
    adjustmentPerGweiBaseFee: '0', curve: { relativeBlocks: [80], relativeAmounts: ['5000000'] } };
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const orderInfo = { chainId: 4663, reactor: UNISWAPX_REACTOR, swapper: wallet,
    nonce: '123', deadline, additionalValidationContract: '0x0000000000000000000000000000000000000000',
    additionalValidationData: '0x', cosigner: filler, startingBaseFee: '1', input, outputs: [receipt] };
  const signedPart = part => ({ ...part,
    curve: { ...part.curve, relativeBlocks: String(part.curve.relativeBlocks[0]) } });
  return { routing: 'DUTCH_V3', quote: { orderId, encodedOrder: '0xabcd', orderInfo },
    permitData: { domain: { chainId: 4663, verifyingContract: PERMIT2 },
      types: { PermitWitnessTransferFrom: [] },
      values: { permitted: { token: POOLS.AAPL.token, amount: amount.toString() },
        spender: UNISWAPX_REACTOR, nonce: orderInfo.nonce, deadline,
        witness: { info: Object.fromEntries(['reactor', 'swapper', 'nonce', 'deadline',
          'additionalValidationContract', 'additionalValidationData'].map(key => [key, orderInfo[key]])),
        cosigner: filler, startingBaseFee: '1', baseInput: signedPart(input),
        baseOutputs: [signedPart(receipt)] } } } };
}

test('one profitable signed order survives a pending retry and is counted only after a verified fill', async () => {
  let balance = amount;
  let orderStatus = 'open';
  let latestBlock = 111n;
  let submitted = 0;
  let signed = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.pathname === '/v1/quote') return new Response(JSON.stringify(fixtureQuote()), { status: 200 });
    if (url.pathname === '/v1/order' && init.method === 'POST') {
      submitted += 1;
      return new Response(JSON.stringify({ orderId, orderStatus: 'open' }), { status: 201 });
    }
    if (url.pathname === '/v1/orders') return new Response(JSON.stringify({ orders: [
      { orderId, orderStatus, type: 'Dutch_V3', chainId: 4663, swapper: wallet,
        txHash: orderStatus === 'filled' ? transactionHash : undefined,
        settledAmounts: orderStatus === 'filled' ? [{ tokenIn: POOLS.AAPL.token, tokenOut: USDG,
          amountIn: amount.toString(), amountOut: output.toString() }] : undefined },
    ] }), { status: 200 });
    throw new Error('Unexpected network request');
  };
  const client = {
    readContract: async ({ address, functionName }) => functionName === 'allowance' ? amount :
      address.toLowerCase() === POOLS.AAPL.token.toLowerCase() ? balance : 0n,
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n, logs: [
      log(POOLS.AAPL.token, wallet, filler, amount),
      log(USDG, filler, wallet, output),
    ] }),
    getBlockNumber: async () => latestBlock,
  };
  const scan = async () => ({ AAPL: { quantity: amount.toString(), spentUsdg: parseUnits('1000', 6).toString() },
    NVDA: { quantity: '0', spentUsdg: '0' } });
  const getBenchmark = () => ({ date: '2026-09-21', totalUsdg: parseUnits('1150', 6).toString(),
    cashUsdg: '0', positions: {
      AAPL: { quantity: amount.toString(), valueUsdg: parseUnits('1150', 6).toString(), soldAtCapture: '0' },
      NVDA: { quantity: '0', valueUsdg: '0', soldAtCapture: '0' },
    } });
  const options = { client, scan, now: opening, clock: () => opening, getBenchmark };
  const identity = { account: { address: wallet, signTypedData: async () => {
    signed += 1;
    return '0x' + 'c'.repeat(130);
  } } };
  try {
    await runExitCycle(board, identity, options);
    assert.equal(submitted, 1);
    assert.equal(signed, 1);
    let orders = JSON.parse(readFileSync(join(directory, '.data/exit-orders.json'), 'utf8'));
    assert.equal(orders.AAPL.pending.orderId, orderId);
    assert.equal(orders.AAPL.pending.minimumUsdg, parseUnits('1151', 6).toString(),
      'the locked treasury-value target sets the required sale proceeds');
    assert.equal(orders.AAPL.soldQuantity, '0');

    await runExitCycle(board, identity, options);
    assert.equal(submitted, 1, 'an open order must not be submitted twice');

    orderStatus = 'filled';
    balance = 0n;
    await runExitCycle(board, identity, options);
    orders = JSON.parse(readFileSync(join(directory, '.data/exit-orders.json'), 'utf8'));
    assert.equal(orders.AAPL.pending.orderId, orderId, 'an unconfirmed fill stays pending');
    latestBlock = 112n;
    await runExitCycle(board, identity, options);
    orders = JSON.parse(readFileSync(join(directory, '.data/exit-orders.json'), 'utf8'));
    assert.equal(orders.AAPL.pending, null);
    assert.equal(orders.AAPL.soldQuantity, amount.toString());
    assert.equal(orders.AAPL.history[0].receivedUsdg, output.toString());
    assert.equal(submitted, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('a quote above purchase cost but below the treasury benchmark never signs or submits', async () => {
  rmSync(join(directory, '.data/exit-orders.json'), { force: true });
  let signed = 0;
  let submitted = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.pathname === '/v1/quote') return new Response(JSON.stringify(fixtureQuote('1100')),
      { status: 200 });
    if (url.pathname === '/v1/order') submitted += 1;
    throw new Error('Unexpected network request');
  };
  const identity = { account: { address: wallet, signTypedData: async () => {
    signed += 1;
    return '0x' + 'c'.repeat(130);
  } } };
  const client = {
    readContract: async ({ address, functionName }) => functionName === 'allowance' ? amount :
      address.toLowerCase() === POOLS.AAPL.token.toLowerCase() ? amount : 0n,
  };
  const scan = async () => ({ AAPL: { quantity: amount.toString(),
    spentUsdg: parseUnits('1000', 6).toString() },
    NVDA: { quantity: '0', spentUsdg: '0' } });
  const getBenchmark = () => ({ date: '2026-09-21', totalUsdg: parseUnits('1150', 6).toString(),
    cashUsdg: '0', positions: {
      AAPL: { quantity: amount.toString(), valueUsdg: parseUnits('1150', 6).toString(), soldAtCapture: '0' },
      NVDA: { quantity: '0', valueUsdg: '0', soldAtCapture: '0' },
    } });
  try {
    await runExitCycle(board, identity, { client, scan, now: opening,
      clock: () => opening, getBenchmark });
    assert.equal(signed, 0);
    assert.equal(submitted, 0);
  } finally { globalThis.fetch = previousFetch; }
});
