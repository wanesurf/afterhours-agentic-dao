import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';
import { USDG } from '../src/config.js';
import { POOLS, V3_FACTORY, V3_ROUTER, quotePool, quoteStockToUsdg, verifyPool, swapV3 } from '../src/v3.js';

function poolClient(ticker, overrides = {}) {
  const route = POOLS[ticker];
  return {
    getChainId: async () => overrides.chainId ?? 4663,
    readContract: async ({ functionName }) => ({
      token0: overrides.token0 ?? USDG,
      token1: overrides.token1 ?? route.token,
      factory: overrides.factory ?? V3_FACTORY,
      fee: overrides.fee ?? route.fee,
      getPool: overrides.pool ?? route.pool,
    })[functionName],
    simulateContract: async ({ address, functionName, args }) => {
      if (functionName === 'quoteExactInputSingle') {
        assert.equal(args[0].tokenIn, USDG);
        assert.equal(args[0].tokenOut, route.token);
        assert.equal(args[0].fee, 500);
        return { result: [parseUnits('0.02', 18), 0n, 0, 100_000n] };
      }
      assert.equal(address.toLowerCase(), V3_ROUTER.toLowerCase());
      assert.equal(functionName, 'exactInputSingle');
      assert.equal(args[0].tokenOut, route.token);
      assert.equal(args[0].amountOutMinimum, parseUnits('0.019', 18));
      return { request: { address, functionName, args } };
    },
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  };
}

test('only the pinned canonical USDG/stock pools can be quoted', async () => {
  const amount = parseUnits('5', 6);
  const quote = await quotePool('AAPL', amount, poolClient('AAPL'));
  assert.equal(quote.amountOut, parseUnits('0.02', 18));
  assert.equal(quote.price, 250);
  await assert.rejects(() => verifyPool('AAPL', poolClient('AAPL', { token1: POOLS.NVDA.token })), /identity mismatch/);
  await assert.rejects(() => verifyPool('AAPL', poolClient('AAPL', { pool: POOLS.NVDA.pool })), /identity mismatch/);
  await assert.rejects(() => verifyPool('AAPL', poolClient('AAPL', { chainId: 1 })), /Wrong RPC chain/);
  await assert.rejects(() => quotePool('AMD', amount, poolClient('AAPL')), /No approved/);
});

test('swap submits the approved direct pool route and minimum output', async () => {
  let sent = 0;
  const client = poolClient('NVDA');
  const identity = {
    account: { address: '0x0000000000000000000000000000000000000001' },
    wallet: { writeContract: async request => {
      sent += 1;
      assert.equal(request.args[0].recipient, identity.account.address);
      return '0x' + 'a'.repeat(64);
    } },
  };
  const result = await swapV3(identity, 'NVDA', parseUnits('5', 6), parseUnits('0.019', 18), client);
  assert.equal(result.status, 'success');
  assert.equal(sent, 1);
  await assert.rejects(() => swapV3(identity, 'NVDA', parseUnits('5', 6), parseUnits('0.019', 18),
    poolClient('NVDA', { fee: 3000 })), /identity mismatch/);
  assert.equal(sent, 1);
});

test('full holding value quotes the reverse stock to USDG route', async () => {
  const client = poolClient('NVDA');
  client.simulateContract = async ({ functionName, args }) => {
    assert.equal(functionName, 'quoteExactInputSingle');
    assert.equal(args[0].tokenIn, POOLS.NVDA.token);
    assert.equal(args[0].tokenOut, USDG);
    assert.equal(args[0].amountIn, parseUnits('0.02', 18));
    return { result: [parseUnits('4.39', 6), 0n, 0, 100_000n] };
  };
  assert.equal(await quoteStockToUsdg('NVDA', parseUnits('0.02', 18), client), parseUnits('4.39', 6));
  assert.equal(await quoteStockToUsdg('NVDA', 0n, client), 0n);
});
