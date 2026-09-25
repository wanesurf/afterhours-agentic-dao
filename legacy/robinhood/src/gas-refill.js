import { decodeEventLog, encodeAbiParameters, formatEther, getAddress, isAddressEqual, keccak256, parseAbi, parseEther } from 'viem';
import { CHAIN_ID, USDG, config } from './config.js';
import { publicClient } from './chain.js';

// The Uniswap URL contains a v4 pool ID (bytes32), not a spendable pool contract.
// This key hashes to the operator-selected ETH/USDG pool ID on Robinhood Chain.
export const GAS_POOL_ID = '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551';
export const GAS_POOL_KEY = Object.freeze({
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: USDG,
  fee: 8388608, // Uniswap v4 dynamic-fee flag
  tickSpacing: 10,
  hooks: getAddress('0x06a889870C8f83640D6816319f72e2aA579b6080'),
});
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
export const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const poolComponents = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
];
const quoterAbi = [{ type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: poolComponents },
    { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ] }], outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] }];
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const tokenAbi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const permitAbi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export function gasPoolId(key = GAS_POOL_KEY) {
  return keccak256(encodeAbiParameters([{ type: 'tuple', components: poolComponents }], [key]));
}

export function gasSwapInput(amountIn, minimumEthOut) {
  if (amountIn <= 0n || amountIn > 100_000000n || minimumEthOut <= 0n) throw new Error('Invalid bounded gas refill');
  // v4 actions: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL. The Universal
  // Router's v4 TAKE_ALL sends native ETH straight to the transaction sender.
  const swap = encodeAbiParameters([{ type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: poolComponents },
    { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' },
    { name: 'hookData', type: 'bytes' },
  ] }], [{ poolKey: GAS_POOL_KEY, zeroForOne: false, amountIn,
    amountOutMinimum: minimumEthOut, minHopPriceX36: 0n, hookData: '0x' }]);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [USDG, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [GAS_POOL_KEY.currency0, minimumEthOut]);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', [swap, settle, take]]);
}

export async function quoteGasRefill(amountIn, client = publicClient) {
  if (amountIn <= 0n || amountIn > 100_000000n) throw new Error('Gas refill amount outside policy');
  if (gasPoolId() !== GAS_POOL_ID) throw new Error('Approved ETH/USDG pool ID mismatch');
  if (await client.getChainId() !== CHAIN_ID) throw new Error('Wrong chain for ETH/USDG refill');
  const { result } = await client.simulateContract({
    address: V4_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: GAS_POOL_KEY, zeroForOne: false, exactAmount: amountIn, hookData: '0x' }],
  });
  if (result[0] <= 0n) throw new Error('Approved ETH/USDG pool returned no ETH');
  return { amountOut: result[0], gasEstimate: result[1] };
}

async function confirmed(hash, client) {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Gas refill transaction reverted: ${hash}`);
  return receipt;
}

export async function prepareGasRefillApprovals({ account, wallet }, amountIn, client = publicClient) {
  if (amountIn <= 0n || amountIn > 100_000000n) throw new Error('Gas refill approval outside policy');
  const txs = [];
  const ercAllowance = await client.readContract({ address: USDG, abi: tokenAbi,
    functionName: 'allowance', args: [account.address, PERMIT2] });
  if (ercAllowance < amountIn) {
    const { request } = await client.simulateContract({ address: USDG, abi: tokenAbi,
      functionName: 'approve', args: [PERMIT2, amountIn], account });
    const hash = await wallet.writeContract(request);
    await confirmed(hash, client);
    txs.push(hash);
  }
  const [permitAmount, permitExpiration] = await client.readContract({ address: PERMIT2,
    abi: permitAbi, functionName: 'allowance', args: [account.address, USDG, UNIVERSAL_ROUTER] });
  const now = Math.floor(Date.now() / 1000);
  if (permitAmount < amountIn || Number(permitExpiration) <= now + 300) {
    const { request } = await client.simulateContract({ address: PERMIT2, abi: permitAbi,
      functionName: 'approve', args: [USDG, UNIVERSAL_ROUTER, amountIn, now + 86400], account });
    const hash = await wallet.writeContract(request);
    await confirmed(hash, client);
    txs.push(hash);
  }
  return txs;
}

export async function prepareGasRefillSwap(account, amountIn, client = publicClient) {
  const quote = await quoteGasRefill(amountIn, client);
  const minOut = quote.amountOut * BigInt(10000 - Math.round(config.gasRefillSlippage * 100)) / 10000n;
  if (minOut < parseEther(config.minGasEth) * 2n) {
    throw new Error('ETH/USDG quote cannot restore the gas reserve at the permitted refill size');
  }
  const input = gasSwapInput(amountIn, minOut);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const { request } = await client.simulateContract({ address: UNIVERSAL_ROUTER,
    abi: routerAbi, functionName: 'execute', args: ['0x10', [input], deadline], account });
  return { request, minOut };
}

export async function swapEarnedUsdgForGas({ account, wallet }, amountIn, prepared, client = publicClient) {
  if (!prepared?.request || prepared.minOut <= 0n) throw new Error('Gas swap must be quoted and simulated first');
  // The transfer logs and ETH balance delta are verified after settlement.
  const beforeEth = await client.getBalance({ address: account.address });
  const hash = await wallet.writeContract(prepared.request);
  const receipt = await confirmed(hash, client);
  let usdgOut = 0n;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, USDG)) continue;
    try {
      const event = decodeEventLog({ abi: tokenAbi, eventName: 'Transfer', data: log.data, topics: log.topics });
      if (isAddressEqual(event.args.from, account.address)) usdgOut += event.args.value;
    } catch { /* not an ERC-20 transfer */ }
  }
  const afterEth = await client.getBalance({ address: account.address });
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const ethReceived = afterEth + gasCost - beforeEth;
  if (usdgOut !== amountIn || ethReceived < prepared.minOut) {
    throw new Error(`Gas refill ${hash} confirmed but balance verification needs operator review`);
  }
  return { hash, ethReceived, usdgSpent: usdgOut, gasCost, beforeEth: formatEther(beforeEth) };
}
