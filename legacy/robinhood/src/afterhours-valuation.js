import { encodeAbiParameters, keccak256 } from 'viem';
import { AFTERHOURS, CHAIN_ID, USDG } from './config.js';
import { publicClient } from './chain.js';
import { V4_QUOTER } from './gas-refill.js';

export const AFTERHOURS_POOL_ID =
  '0x5054ee8f684356b9e050d6322625c5480d43d64abbb4126c3857e8453786d6a8';
export const AFTERHOURS_POOL_KEY = Object.freeze({
  currency0: USDG,
  currency1: AFTERHOURS,
  fee: 0,
  tickSpacing: 200,
  hooks: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
});
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

export async function quoteAfterhoursToUsdg(amount, client = publicClient) {
  if (amount < 0n || amount >= 2n ** 128n) throw new Error('$AFTERHOURS quote amount outside uint128');
  if (amount === 0n) return 0n;
  if (await client.getChainId() !== CHAIN_ID) throw new Error('Wrong chain for $AFTERHOURS valuation');
  const poolId = keccak256(encodeAbiParameters([{ type: 'tuple', components: poolComponents }],
    [AFTERHOURS_POOL_KEY]));
  if (poolId !== AFTERHOURS_POOL_ID) throw new Error('$AFTERHOURS pool ID mismatch');
  const { result } = await client.simulateContract({
    address: V4_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: AFTERHOURS_POOL_KEY, zeroForOne: false, exactAmount: amount, hookData: '0x' }],
  });
  if (result[0] <= 0n) throw new Error('$AFTERHOURS pool returned zero USDG');
  return result[0];
}
