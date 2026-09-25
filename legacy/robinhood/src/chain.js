import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, isAddressEqual } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, CHAIN_ID, USDG, PONS_FACTORY, EXPLORER } from './config.js';

export const chain = { id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } }, blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } } };
export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 15_000 }) });
const escrowAbi = parseAbi([
  'function balanceOfToken(address recipient, address token) view returns (uint256)',
  'function claimToken(address token)',
]);
const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const factoryAbi = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'function approvedPairTokens(address pairToken) view returns (bool)',
]);

export function signer() {
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) throw new Error('Set a dedicated AGENT_PRIVATE_KEY in .env');
  const account = privateKeyToAccount(config.privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(config.rpcUrl, { timeout: 15_000 }) });
  return { account, wallet };
}

export async function verifyLaunch(address) {
  if (!config.ponsToken) throw new Error('Set PONS_TOKEN_ADDRESS after launching a Pons V2 token paired with USDG');
  const [network, launch, approved] = await Promise.all([
    publicClient.getChainId(),
    publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: 'getLaunchedToken', args: [config.ponsToken] }),
    publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: 'approvedPairTokens', args: [USDG] }),
  ]);
  if (network !== CHAIN_ID) throw new Error(`Wrong RPC chain: ${network}`);
  if (!approved || !launch.exists) throw new Error('Pons V2 launch absent or USDG pair no longer approved');
  if (!isAddressEqual(launch.creatorFeeRecipient, address)) throw new Error('Pons creatorFeeRecipient does not match agent wallet');
  if (!isAddressEqual(launch.pairToken, USDG)) throw new Error('Pons launch is not USDG paired');
  return launch;
}

export async function balances(address) {
  const [owed, usdg, eth] = await Promise.all([
    publicClient.readContract({ address: config.feeEscrow, abi: escrowAbi, functionName: 'balanceOfToken', args: [address, USDG] }),
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    publicClient.getBalance({ address }),
  ]);
  return { owed, usdg, eth };
}

export class GasReserveError extends Error {
  constructor(balanceEth, reserveEth) {
    super(`ETH gas balance ${balanceEth} below MIN_GAS_ETH ${reserveEth}`);
    this.balanceEth = balanceEth;
    this.reserveEth = reserveEth;
  }
}

export function ensureGas(eth) {
  if (eth < parseEther(config.minGasEth)) {
    throw new GasReserveError(formatEther(eth), config.minGasEth);
  }
}

export async function claimRewards({ account, wallet }, ledger) {
  const before = await balances(account.address);
  if (before.owed < config.minClaim) return { claimed: 0n, tx: null, before };
  ensureGas(before.eth);
  const { request } = await publicClient.simulateContract({ address: config.feeEscrow, abi: escrowAbi, functionName: 'claimToken', args: [USDG], account });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Pons claim reverted: ${hash}`);
  // Count only USDG Transfer events from the escrow to this exact wallet.
  const { decodeEventLog } = await import('viem');
  let transferred = 0n;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, USDG)) continue;
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, eventName: 'Transfer' });
      if (isAddressEqual(decoded.args.from, config.feeEscrow) && isAddressEqual(decoded.args.to, account.address)) transferred += decoded.args.value;
    } catch { /* unrelated USDG event */ }
  }
  const after = await balances(account.address);
  const delta = after.usdg > before.usdg ? after.usdg - before.usdg : 0n;
  const claimed = [transferred, before.owed, delta].reduce((a, b) => a < b ? a : b);
  if (!claimed) throw new Error(`Claim ${hash} succeeded but no matching USDG transfer was verified; no funds credited`);
  ledger.creditClaim(claimed, hash);
  return { claimed, tx: hash, before };
}
