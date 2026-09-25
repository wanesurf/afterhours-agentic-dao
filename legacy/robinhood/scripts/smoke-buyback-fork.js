// Disposable fork smoke test. Never points at a public RPC for writes.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, formatUnits,
  http, parseAbi, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const rpc = process.env.BUYBACK_FORK_RPC_URL || 'http://127.0.0.1:18766';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(rpc)) {
  throw new Error('Buyback smoke test requires a localhost Anvil fork');
}
const chain = { id: 4663, name: 'Robinhood Anvil fork', nativeCurrency: {
  name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const client = createPublicClient({ chain, transport: http(rpc, { timeout: 30_000 }) });
await client.request({ method: 'anvil_nodeInfo' });
if (await client.getChainId() !== 4663) throw new Error('Wrong fork chain');
const directory = mkdtempSync(join(tmpdir(), 'afterhours-buyback-fork-'));
process.chdir(directory);
process.env.AGENT_PRIVATE_KEY = '';
process.env.AGENT_PUBLIC_ADDRESS = '';
const { config, USDG, AFTERHOURS } = await import('../src/config.js');
const { runBuybackCycle } = await import('../src/buyback.js');
config.buybackEnabled = true;
const trader = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: trader, chain, transport: http(rpc) });
const liveAgent = '0x141B4102b22457D397EBeB69fa6ea052F604C9b1';
const tokenAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
await client.request({ method: 'anvil_setBalance', params: [trader.address, '0x' + parseEther('1').toString(16)] });
await client.request({ method: 'anvil_setBalance', params: [liveAgent, '0x' + parseEther('1').toString(16)] });
await client.request({ method: 'anvil_impersonateAccount', params: [liveAgent] });
const fundingHash = await client.request({ method: 'eth_sendTransaction', params: [{ from: liveAgent,
  to: USDG, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer',
    args: [trader.address, 150_000000n] }), value: '0x0' }] });
await client.waitForTransactionReceipt({ hash: fundingHash });
const beforeSupply = await client.readContract({ address: AFTERHOURS, abi: tokenAbi, functionName: 'totalSupply' });
const beforeCash = await client.readContract({ address: USDG, abi: tokenAbi,
  functionName: 'balanceOf', args: [trader.address] });
if (beforeCash !== 150_000000n) throw new Error('Fork funding failed');
const exits = { available: true, count: 1, pendingCount: 0,
  totalVerifiedAcquisitionUsdg: '3325', totalAcquisitionUsdg: '3325',
  totalProceedsUsdg: '3354.754473' };
const options = { client, getExits: () => exits,
  scan: async () => ({ throughBlock: 123 }),
  readHistory: () => ({ throughBlock: 123, buys: [{ spentUsdg: '3325000000', gasWei: '0' }] }) };
try {
  await runBuybackCycle({ account: trader, wallet }, options);
  const state = JSON.parse(readFileSync(resolve('.data/buyback.json'), 'utf8'));
  if (state.history.length !== 1 || state.pending || state.spentUsdg !== '29754473') {
    throw new Error('Fork buyback and burn did not settle exactly once');
  }
  const afterSupply = await client.readContract({ address: AFTERHOURS, abi: tokenAbi, functionName: 'totalSupply' });
  const afterCash = await client.readContract({ address: USDG, abi: tokenAbi,
    functionName: 'balanceOf', args: [trader.address] });
  if (beforeSupply - afterSupply !== BigInt(state.burned) ||
      beforeCash - afterCash !== BigInt(state.spentUsdg)) {
    throw new Error('Fork balances or supply differ from verified ledger');
  }
  await runBuybackCycle({ account: trader, wallet }, options);
  const repeated = JSON.parse(readFileSync(resolve('.data/buyback.json'), 'utf8'));
  if (repeated.history.length !== 1) throw new Error('Buyback repeated the same profit');
  console.log(JSON.stringify({ spentUsdg: formatUnits(BigInt(state.spentUsdg), 6),
    burned: formatUnits(BigInt(state.burned), 18),
    swapTxHash: state.history[0].swapTxHash,
    burnTxHash: state.history[0].burnTxHash,
    forkOnly: true }));
  rmSync(directory, { recursive: true, force: true });
} catch (error) {
  console.error(`Fork state retained at ${directory}`);
  let cause = error;
  for (let i = 0; i < 5 && cause; i++) {
    console.error(`${cause.name || 'Error'}: ${cause.shortMessage || cause.message}`);
    cause = cause.cause;
  }
  process.exitCode = 1;
}
