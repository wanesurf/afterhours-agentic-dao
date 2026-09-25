import { formatUnits, isAddressEqual, parseAbi } from 'viem';
import { CHAIN_ID, USDG } from './config.js';
import { publicClient } from './chain.js';

// Pinned to the two USDG/Stock Token pools selected by the operator.
export const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
export const V3_QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
export const V3_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
export const POOLS = Object.freeze({
  AAPL: Object.freeze({ token: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', pool: '0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d', fee: 500 }),
  NVDA: Object.freeze({ token: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', pool: '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3', fee: 500 }),
});
const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function fee() view returns (uint24)',
]);
const factoryAbi = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)']);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

export async function verifyPool(ticker, client = publicClient) {
  const route = POOLS[ticker];
  if (!route) throw new Error(`No approved USDG pool for ${ticker}`);
  if (await client.getChainId() !== CHAIN_ID) throw new Error('Wrong RPC chain for stock swap');
  const [token0, token1, factory, fee, factoryPool] = await Promise.all([
    ...['token0', 'token1', 'factory', 'fee'].map(functionName => client.readContract({ address: route.pool, abi: poolAbi, functionName })),
    client.readContract({ address: V3_FACTORY, abi: factoryAbi, functionName: 'getPool', args: [USDG, route.token, route.fee] }),
  ]);
  if (!isAddressEqual(token0, USDG) || !isAddressEqual(token1, route.token) ||
    !isAddressEqual(factory, V3_FACTORY) || fee !== route.fee || !isAddressEqual(factoryPool, route.pool)) {
    throw new Error(`Uniswap v3 ${ticker}/USDG pool identity mismatch`);
  }
  return route;
}

export async function quotePool(ticker, amountIn, client = publicClient) {
  if (amountIn <= 0n) throw new Error('Quote amount must be positive');
  const route = await verifyPool(ticker, client);
  const { result } = await client.simulateContract({
    address: V3_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: USDG, tokenOut: route.token, amountIn, fee: route.fee, sqrtPriceLimitX96: 0n }],
  });
  const amountOut = result[0];
  if (amountOut <= 0n) throw new Error(`${ticker} pool returned zero stock output`);
  const price = Number(formatUnits(amountIn, 6)) / Number(formatUnits(amountOut, 18));
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${ticker} pool quote is invalid`);
  return { amountOut, price, pool: route.pool, fee: route.fee };
}

export async function quoteStockToUsdg(ticker, stockAmount, client = publicClient) {
  if (stockAmount < 0n) throw new Error('Stock amount must be nonnegative');
  if (stockAmount === 0n) return 0n;
  const route = await verifyPool(ticker, client);
  const { result } = await client.simulateContract({
    address: V3_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: route.token, tokenOut: USDG, amountIn: stockAmount, fee: route.fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

export async function prepareV3Approval({ account, wallet }, amount, client = publicClient) {
  if (amount <= 0n || amount > 1000_000000n) throw new Error('Approval amount outside buy policy');
  const allowance = await client.readContract({ address: USDG, abi: erc20Abi, functionName: 'allowance', args: [account.address, V3_ROUTER] });
  if (allowance >= amount) return [];
  const { request } = await client.simulateContract({ address: USDG, abi: erc20Abi, functionName: 'approve', args: [V3_ROUTER, amount], account });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`USDG router approval failed: ${hash}`);
  return [hash];
}

export async function swapV3({ account, wallet }, ticker, amountIn, minOut, client = publicClient) {
  if (amountIn <= 0n || minOut <= 0n) throw new Error('Invalid swap bounds');
  const route = await verifyPool(ticker, client);
  const params = {
    tokenIn: USDG, tokenOut: route.token, fee: route.fee,
    recipient: account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
  };
  const { request } = await client.simulateContract({ address: V3_ROUTER, abi: routerAbi, functionName: 'exactInputSingle', args: [params], account });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  return { hash, status: receipt.status };
}
