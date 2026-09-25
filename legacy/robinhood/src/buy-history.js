import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { formatUnits, isAddressEqual } from 'viem';
import { CHAIN_ID, WATCHLIST } from './config.js';
import { publicClient } from './chain.js';
import { firstBlockAtOrAfter, firstPossibleBuy, getLogsBatched, purchaseFromReceipt } from './exit-basis.js';
import { POOLS } from './v3.js';

const path = resolve('.data/buy-history.json');
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const unsigned = /^\d+$/;

export function readBuyHistory(wallet, file = path) {
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (state.version !== 1 || !isAddressEqual(state.wallet, wallet) ||
      !Number.isSafeInteger(state.throughBlock) || state.throughBlock < 0 ||
      !Array.isArray(state.buys) || state.buys.some(buy =>
        !WATCHLIST.includes(buy.ticker) || !hashPattern.test(buy.txHash || '') ||
        !unsigned.test(buy.quantity || '') || !unsigned.test(buy.spentUsdg || '') ||
        (buy.gasWei !== undefined && !unsigned.test(buy.gasWei)) ||
        !Number.isSafeInteger(buy.blockNumber) || buy.blockNumber < 0 || buy.blockNumber > state.throughBlock ||
        !Number.isFinite(Date.parse(buy.at)))) {
    throw new Error('Purchase receipt index is invalid or belongs to another wallet');
  }
  if (new Set(state.buys.map(buy => buy.txHash.toLowerCase())).size !== state.buys.length) {
    throw new Error('Purchase receipt index has duplicate transactions');
  }
  return state;
}

function saveBuyHistory(state, file) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

// This index is separate from the exit basis cache so rebuilding historical
// rows never delays or changes the treasury's sell eligibility checks.
export async function scanBuyHistory(wallet, {
  client = publicClient, file = path, throughBlock = null,
} = {}) {
  if (await client.getChainId() !== CHAIN_ID) throw new Error('Wrong chain for purchase history');
  const latest = throughBlock === null ? await client.getBlockNumber() : BigInt(throughBlock);
  const finalized = latest > 12n ? latest - 12n : latest;
  let state = readBuyHistory(wallet, file);
  if (!state) {
    const first = await firstBlockAtOrAfter(firstPossibleBuy, finalized, client);
    state = { version: 1, wallet, throughBlock: Number(first - 1n), buys: [] };
  }
  const fromBlock = BigInt(state.throughBlock) + 1n;
  const next = structuredClone(state);
  // Older indexes predate execution-gas accounting. Backfill from the same
  // verified purchase receipts before this index can fund any buyback.
  for (let i = 0; i < next.buys.length; i += 12) {
    const batch = next.buys.slice(i, i + 12).filter(buy => buy.gasWei === undefined);
    if (!batch.length) continue;
    const receipts = await Promise.all(batch.map(buy => client.getTransactionReceipt({ hash: buy.txHash })));
    for (let j = 0; j < batch.length; j++) {
      const buy = batch[j];
      const receipt = receipts[j];
      if (receipt.status !== 'success' || !isAddressEqual(receipt.from, wallet) ||
          receipt.transactionHash?.toLowerCase() !== buy.txHash.toLowerCase() ||
          receipt.blockNumber !== BigInt(buy.blockNumber) ||
          typeof receipt.gasUsed !== 'bigint' || typeof receipt.effectiveGasPrice !== 'bigint') {
        throw new Error('Purchase gas receipt does not match verified history');
      }
      buy.gasWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
    }
    saveBuyHistory(next, file);
  }
  if (fromBlock > finalized) return next;
  const known = new Set(next.buys.map(buy => buy.txHash.toLowerCase()));
  for (let start = fromBlock; start <= finalized; start += 2_000n) {
    const end = start + 1_999n < finalized ? start + 1_999n : finalized;
    for (const ticker of WATCHLIST) {
      const route = POOLS[ticker];
      const logs = await getLogsBatched(client, route.token, { from: route.pool, to: wallet }, start, end);
      for (let i = 0; i < logs.length; i += 12) {
        const batch = await Promise.all(logs.slice(i, i + 12).map(async log => {
          if (!hashPattern.test(log.transactionHash || '') || known.has(log.transactionHash.toLowerCase())) {
            throw new Error('Duplicate or invalid purchase receipt hash');
          }
          const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
          if (receipt.transactionHash?.toLowerCase() !== log.transactionHash.toLowerCase() ||
              receipt.blockNumber !== log.blockNumber) throw new Error('Purchase receipt block mismatch');
          const spent = purchaseFromReceipt(receipt, ticker, wallet, log.args.value);
          if (typeof receipt.gasUsed !== 'bigint' || typeof receipt.effectiveGasPrice !== 'bigint') {
            throw new Error('Purchase receipt lacks gas cost');
          }
          const block = await client.getBlock({ blockNumber: log.blockNumber });
          return { ticker, txHash: log.transactionHash,
            blockNumber: Number(log.blockNumber), at: new Date(Number(block.timestamp) * 1000).toISOString(),
            quantity: log.args.value.toString(), spentUsdg: spent.toString(),
            gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
        }));
        for (const buy of batch) {
          if (known.has(buy.txHash.toLowerCase())) throw new Error('Duplicate purchase receipt');
          known.add(buy.txHash.toLowerCase());
          next.buys.push(buy);
        }
      }
    }
    next.buys.sort((a, b) => a.blockNumber - b.blockNumber || a.txHash.localeCompare(b.txHash));
    next.throughBlock = Number(end);
    saveBuyHistory(next, file);
  }
  return next;
}

export function publicBuyHistory(wallet, ticker, file = path) {
  if (!WATCHLIST.includes(ticker)) return null;
  const state = readBuyHistory(wallet, file);
  if (!state) return { available: false, ticker, indexedThroughBlock: null, buys: [] };
  return { available: true, ticker, indexedThroughBlock: state.throughBlock,
    buys: state.buys.filter(buy => buy.ticker === ticker).slice().reverse().map(buy => ({
      txHash: buy.txHash, at: buy.at, quantity: formatUnits(BigInt(buy.quantity), 18),
      spentUsdg: formatUnits(BigInt(buy.spentUsdg), 6),
    })) };
}
