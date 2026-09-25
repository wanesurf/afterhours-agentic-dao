import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, formatUnits,
  isAddressEqual, keccak256, parseAbi, parseAbiItem, parseUnits } from 'viem';
import { AFTERHOURS, CHAIN_ID, PONS_FACTORY, USDG, WATCHLIST, config } from './config.js';
import { ensureGas, publicClient } from './chain.js';
import { buybackBudget, minimumTokens } from './buyback-policy.js';
import { readBuyHistory, scanBuyHistory } from './buy-history.js';
import { getLogsBatched } from './exit-basis.js';
import { UNIVERSAL_ROUTER, V4_QUOTER,
  prepareGasRefillApprovals } from './gas-refill.js';
import { POOLS } from './v3.js';
import { publicExits, recordActivity } from './status.js';

const statePath = resolve('.data/buyback.json');
const ZERO = '0x0000000000000000000000000000000000000000';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
export const AFTERHOURS_POOL_ID =
  '0x5054ee8f684356b9e050d6322625c5480d43d64abbb4126c3857e8453786d6a8';
// No buyback executor existed before this observed Robinhood block. A lost
// private ledger can be recreated only if no agent burn happened since then.
const FIRST_BUYBACK_BLOCK = 68_875_176n;
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const tokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function launchFactory() view returns (address)',
  'function burn(uint256 amount)',
]);
const factoryAbi = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'function memeHook() view returns (address)',
]);
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

function validAtomic(value) { return typeof value === 'string' && /^\d+$/.test(value); }
function validHash(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value); }

function save(state, path = statePath) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

async function load(wallet, client, path = statePath) {
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A lost private ledger must never recreate spendable historical profit.
    const latest = await client.getBlockNumber();
    if (latest < FIRST_BUYBACK_BLOCK) throw new Error('Buyback deployment baseline is ahead of the RPC');
    const burns = await getLogsBatched(client, AFTERHOURS, { from: wallet, to: ZERO },
      FIRST_BUYBACK_BLOCK, latest);
    if (burns.length) throw new Error('Past agent burns exist without a buyback ledger; reconcile before trading');
    state = { version: 1, wallet, token: AFTERHOURS, spentUsdg: '0', burned: '0',
      pending: null, history: [] };
    save(state, path);
  }
  if (state.version !== 1 || !isAddressEqual(state.wallet, wallet) ||
      !isAddressEqual(state.token, AFTERHOURS) || !validAtomic(state.spentUsdg) ||
      !validAtomic(state.burned) || !Array.isArray(state.history) ||
      state.history.some(entry => !validAtomic(entry.spentUsdg) || !validAtomic(entry.burned) ||
        !validAtomic(entry.gasWei || '0') ||
        !validHash(entry.swapTxHash) || !validHash(entry.burnTxHash))) {
    throw new Error('Buyback ledger is invalid or belongs to another wallet');
  }
  const spent = state.history.reduce((sum, entry) => sum + BigInt(entry.spentUsdg), 0n);
  const burned = state.history.reduce((sum, entry) => sum + BigInt(entry.burned), 0n);
  if (spent !== BigInt(state.spentUsdg) || burned !== BigInt(state.burned)) {
    throw new Error('Buyback ledger totals disagree with receipts');
  }
  if (state.pending && (!['swap_signed', 'bought', 'burn_signed'].includes(state.pending.phase) ||
      !validAtomic(state.pending.amountUsdg) || !validAtomic(state.pending.minOut) ||
      !validAtomic(state.pending.preTokenBalance) || !validHash(state.pending.swapTxHash) ||
      (state.pending.phase !== 'swap_signed' && !validAtomic(state.pending.bought)) ||
      (state.pending.phase === 'burn_signed' &&
        (!validAtomic(state.pending.preSupply) || !validHash(state.pending.burnTxHash))) ||
      (state.pending.rawTx && (!/^0x[0-9a-fA-F]+$/.test(state.pending.rawTx) ||
        keccak256(state.pending.rawTx).toLowerCase() !==
          (state.pending.phase === 'burn_signed' ? state.pending.burnTxHash : state.pending.swapTxHash).toLowerCase())))) {
    throw new Error('Pending buyback is invalid');
  }
  return state;
}

function transferAmount(receipt, token, from, to) {
  let amount = 0n;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, token)) continue;
    let event;
    try { event = decodeEventLog({ abi: [transfer], data: log.data, topics: log.topics }); }
    catch { continue; }
    if ((!from || isAddressEqual(event.args.from, from)) &&
        (!to || isAddressEqual(event.args.to, to))) amount += event.args.value;
  }
  return amount;
}

export function verifiedSwapReceipt(receipt, wallet, amountUsdg, minOut) {
  if (receipt.status !== 'success') throw new Error('Buyback swap reverted');
  const spent = transferAmount(receipt, USDG, wallet, null);
  const bought = transferAmount(receipt, AFTERHOURS, null, wallet);
  if (spent !== amountUsdg || bought < minOut || bought <= 0n) {
    throw new Error('Buyback swap receipt does not match signed USDG spend and minimum tokens');
  }
  return bought;
}

export function verifiedBurnReceipt(receipt, wallet, amount) {
  if (receipt.status !== 'success' ||
      transferAmount(receipt, AFTERHOURS, wallet, ZERO) !== amount || amount <= 0n) {
    throw new Error('Burn receipt did not destroy the bought tokens');
  }
  return amount;
}

async function confirmed(hash, client) {
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash }); }
  catch (error) {
    if (/not found/i.test(error.message)) return null;
    throw error;
  }
  if (receipt.status !== 'success') throw new Error(`Buyback transaction reverted: ${hash}`);
  if (await client.getBlockNumber() < receipt.blockNumber + 12n) return null;
  return receipt;
}

async function signAndPersist(state, phase, request, identity, client) {
  const prepared = await client.prepareTransactionRequest({ ...request, account: identity.account,
    chain: identity.wallet.chain });
  const rawTx = await identity.account.signTransaction(prepared);
  const hash = keccak256(rawTx);
  state.pending = { ...state.pending, phase, rawTx, ...(phase === 'swap_signed' ?
    { swapTxHash: hash } : { burnTxHash: hash }) };
  save(state);
  await client.sendRawTransaction({ serializedTransaction: rawTx });
  // Robinhood blocks are short. Confirm before advancing to the burn when
  // possible; a timeout leaves the exact signed transaction in the ledger.
  if (typeof client.waitForTransactionReceipt === 'function') {
    try { await client.waitForTransactionReceipt({ hash, confirmations: 13, timeout: 120_000 }); }
    catch (error) { if (!/timed out|timeout/i.test(error.message)) throw error; }
  }
  return hash;
}

async function reconcile(state, identity, client) {
  const pending = state.pending;
  if (!pending) return false;
  const hash = pending.phase === 'burn_signed' ? pending.burnTxHash : pending.swapTxHash;
  if (pending.phase !== 'bought') {
    const receipt = await confirmed(hash, client);
    if (!receipt) {
      // Rebroadcast only the exact already-signed bytes after an uncertain
      // response. A new nonce or changed amount could duplicate a buyback.
      if (pending.rawTx && typeof client.getTransaction === 'function') {
        let known = false;
        try { known = Boolean(await client.getTransaction({ hash })); }
        catch (error) { if (!/not found/i.test(error.message)) throw error; }
        if (!known) {
          try { await client.sendRawTransaction({ serializedTransaction: pending.rawTx }); }
          catch (error) { if (!/already known|known transaction/i.test(error.message)) throw error; }
        }
      }
      return true;
    }
    if (pending.phase === 'swap_signed') {
      const spent = BigInt(pending.amountUsdg);
      const bought = verifiedSwapReceipt(receipt, identity.account.address, spent, BigInt(pending.minOut));
      const balance = await client.readContract({ address: AFTERHOURS, abi: tokenAbi,
        functionName: 'balanceOf', args: [identity.account.address] });
      if (balance < BigInt(pending.preTokenBalance) + bought) {
        throw new Error('Bought tokens are missing before burn');
      }
      pending.phase = 'bought';
      pending.bought = bought.toString();
      pending.swapGasWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      delete pending.rawTx;
      save(state);
      recordActivity('buyback_confirmed', 'Profit-funded $AFTERHOURS buyback confirmed',
        `${formatUnits(spent, 6)} USDG bought ${formatUnits(bought, 18)} $AFTERHOURS. Burn pending.`,
        { amountUsdg: formatUnits(spent, 6), txHash: pending.swapTxHash });
    } else {
      const burned = verifiedBurnReceipt(receipt, identity.account.address, BigInt(pending.bought));
      const supply = await client.readContract({ address: AFTERHOURS, abi: tokenAbi, functionName: 'totalSupply' });
      if (supply > BigInt(pending.preSupply) - burned) {
        throw new Error('Token supply did not decrease by the burned amount');
      }
      state.spentUsdg = (BigInt(state.spentUsdg) + BigInt(pending.amountUsdg)).toString();
      state.burned = (BigInt(state.burned) + burned).toString();
      const gasWei = BigInt(pending.approvalGasWei || '0') +
        BigInt(pending.swapGasWei) + receipt.gasUsed * receipt.effectiveGasPrice;
      state.history.push({ spentUsdg: pending.amountUsdg, burned: burned.toString(),
        gasWei: gasWei.toString(),
        swapTxHash: pending.swapTxHash, burnTxHash: pending.burnTxHash,
        at: new Date().toISOString() });
      state.pending = null;
      save(state);
      recordActivity('burn_confirmed', 'Bought $AFTERHOURS burned',
        `${formatUnits(burned, 18)} tokens permanently removed from total supply.`,
        { txHash: pending.burnTxHash });
      return false;
    }
  }
  const bought = BigInt(pending.bought);
  const preSupply = await client.readContract({ address: AFTERHOURS, abi: tokenAbi, functionName: 'totalSupply' });
  await client.simulateContract({ address: AFTERHOURS, abi: tokenAbi,
    functionName: 'burn', args: [bought], account: identity.account });
  pending.preSupply = preSupply.toString();
  await signAndPersist(state, 'burn_signed', { to: AFTERHOURS,
    data: encodeFunctionData({ abi: tokenAbi, functionName: 'burn', args: [bought] }),
    value: 0n }, identity, client);
  if (await confirmed(state.pending.burnTxHash, client)) {
    return reconcile(state, identity, client);
  }
  return true;
}

async function verifiedPool(client) {
  if (await client.getChainId() !== CHAIN_ID) throw new Error('Wrong chain for buyback');
  const [factory, launch, hook] = await Promise.all([
    client.readContract({ address: AFTERHOURS, abi: tokenAbi, functionName: 'launchFactory' }),
    client.readContract({ address: PONS_FACTORY, abi: factoryAbi,
      functionName: 'getLaunchedToken', args: [AFTERHOURS] }),
    client.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: 'memeHook' }),
  ]);
  if (!isAddressEqual(factory, PONS_FACTORY) || !launch.exists || launch.phase !== 2 ||
      !isAddressEqual(launch.token, AFTERHOURS) || !isAddressEqual(launch.pairToken, USDG) ||
      !isAddressEqual(hook, HOOK) || launch.poolFee !== 0 || launch.tickSpacing !== 200) {
    throw new Error('$AFTERHOURS graduated USDG pool identity changed');
  }
  const key = { currency0: USDG, currency1: AFTERHOURS, fee: 0, tickSpacing: 200, hooks: HOOK };
  const poolId = keccak256(encodeAbiParameters([{ type: 'tuple', components: poolComponents }], [key]));
  if (poolId !== AFTERHOURS_POOL_ID) throw new Error('$AFTERHOURS pool ID differs from approved Uniswap pool');
  return key;
}

async function quote(client, poolKey, zeroForOne, exactAmount) {
  if (exactAmount <= 0n || exactAmount >= 2n ** 128n) throw new Error('Buyback quote amount outside uint128');
  const { result } = await client.simulateContract({ address: V4_QUOTER, abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey, zeroForOne, exactAmount, hookData: '0x' }] });
  if (result[0] <= 0n) throw new Error('Approved pool returned zero output');
  return result[0];
}

export function buybackSwapActions(poolKey, amount, minOut) {
  const swap = encodeAbiParameters([{ type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: poolComponents },
    { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' },
    { name: 'hookData', type: 'bytes' },
  ] }], [{ poolKey, zeroForOne: true, amountIn: amount, amountOutMinimum: minOut,
    hookData: '0x', minHopPriceX36: 0n }]);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [USDG, amount]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [AFTERHOURS, minOut]);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', [swap, settle, take]]);
}

export async function runBuybackCycle(identity, { client = publicClient,
  getExits = publicExits,
  scan = scanBuyHistory, readHistory = readBuyHistory,
} = {}) {
  if (!config.buybackEnabled) return;
  const wallet = identity.account.address;
  const state = await load(wallet, client);
  if (await reconcile(state, identity, client)) return;
  const exits = getExits();
  if (!exits.available || exits.pendingCount || !exits.count ||
      exits.totalVerifiedAcquisitionUsdg === null) return;
  const proceeds = parseUnits(exits.totalProceedsUsdg, 6);
  const acquisitionCost = parseUnits(exits.totalAcquisitionUsdg, 6);
  if (proceeds <= acquisitionCost + BigInt(state.spentUsdg)) return;
  const purchaseIndex = await scan(wallet, { client });
  const history = readHistory(wallet);
  if (!history || history.throughBlock !== purchaseIndex.throughBlock ||
      history.buys.some(buy => !validAtomic(buy.gasWei))) return;
  const indexedCost = history.buys.reduce((sum, buy) => sum + BigInt(buy.spentUsdg), 0n);
  if (indexedCost !== parseUnits(exits.totalVerifiedAcquisitionUsdg, 6)) {
    throw new Error('Purchase gas index does not cover every verified acquisition');
  }
  const stockBalances = await Promise.all(WATCHLIST.map(ticker => client.readContract({
    address: POOLS[ticker].token, abi: tokenAbi, functionName: 'balanceOf', args: [wallet],
  })));
  if (stockBalances.some(balance => balance !== 0n)) return;
  const cash = await client.readContract({ address: USDG, abi: tokenAbi,
    functionName: 'balanceOf', args: [wallet] });
  const budget = buybackBudget({ proceeds: proceeds.toString(), acquisitionCost: acquisitionCost.toString(),
    alreadySpent: state.spentUsdg, cash: cash.toString(),
    cashReserve: config.buybackCashReserveUsdg.toString(),
    maxPerTrade: config.buybackMaximumUsdg.toString() });
  if (budget.amount < config.buybackMinimumUsdg) return;
  ensureGas(await client.getBalance({ address: wallet }));
  const poolKey = await verifiedPool(client);
  const [fullQuote, oneQuote] = await Promise.all([
    quote(client, poolKey, true, budget.amount), quote(client, poolKey, true, 1_000000n),
  ]);
  const minimumForImpact = oneQuote * budget.amount / 1_000000n *
    BigInt(10_000 - Math.round(config.buybackMaxImpactPct * 100)) / 10_000n;
  if (fullQuote < minimumForImpact) {
    recordActivity('buyback_quote_rejected', 'Buyback pool impact too high',
      'The approved $AFTERHOURS pool quote exceeded the configured price-impact limit.');
    return;
  }
  const minOut = minimumTokens(fullQuote, Math.round(config.buybackSlippagePct * 100));
  // Reuse the same exact USDG -> Permit2 -> pinned Universal Router approvals
  // as the proven gas-refill route. Amounts here are capped at 100 USDG.
  const approvals = await prepareGasRefillApprovals(identity, budget.amount, client);
  let approvalGasWei = 0n;
  for (const hash of approvals) {
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('USDG buyback approval did not confirm');
    approvalGasWei += receipt.gasUsed * receipt.effectiveGasPrice;
  }
  const refreshed = await quote(client, poolKey, true, budget.amount);
  if (refreshed < minOut) return;
  if (refreshed < minimumForImpact) return;
  ensureGas(await client.getBalance({ address: wallet }));
  const finalMin = minimumTokens(refreshed, Math.round(config.buybackSlippagePct * 100));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
  const input = buybackSwapActions(poolKey, budget.amount, finalMin);
  const data = encodeFunctionData({ abi: routerAbi, functionName: 'execute',
    args: ['0x10', [input], deadline] });
  await client.simulateContract({ address: UNIVERSAL_ROUTER, abi: routerAbi,
    functionName: 'execute', args: ['0x10', [input], deadline], account: identity.account });
  const preTokenBalance = await client.readContract({ address: AFTERHOURS, abi: tokenAbi,
    functionName: 'balanceOf', args: [wallet] });
  state.pending = { phase: 'preparing', amountUsdg: budget.amount.toString(),
    minOut: finalMin.toString(), preTokenBalance: preTokenBalance.toString(),
    approvalGasWei: approvalGasWei.toString() };
  await signAndPersist(state, 'swap_signed', { to: UNIVERSAL_ROUTER, data, value: 0n }, identity, client);
  await reconcile(state, identity, client);
}
