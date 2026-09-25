import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodeEventLog, isAddressEqual, parseAbiItem } from 'viem';
import { CHAIN_ID, USDG, WATCHLIST } from './config.js';
import { publicClient } from './chain.js';
import { POOLS, V3_ROUTER } from './v3.js';

const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const defaultPath = resolve('.data/exit-basis.json');
export const firstPossibleBuy = Date.parse('2026-09-19T00:00:00Z') / 1000;

function read(path, wallet) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state.version !== 1 || !isAddressEqual(state.wallet, wallet) ||
        !Number.isSafeInteger(state.throughBlock) || state.throughBlock < 0 ||
        WATCHLIST.some(ticker => !/^\d+$/.test(state[ticker]?.quantity || '') ||
          !/^\d+$/.test(state[ticker]?.spentUsdg || ''))) {
      throw new Error('Exit acquisition cache is invalid');
    }
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function save(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export async function firstBlockAtOrAfter(timestampSeconds, latest, client) {
  let low = 0n;
  let high = latest;
  while (low < high) {
    const middle = (low + high) / 2n;
    const block = await client.getBlock({ blockNumber: middle });
    if (Number(block.timestamp) < timestampSeconds) low = middle + 1n;
    else high = middle;
  }
  return low;
}

export async function getLogsBatched(client, address, args, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  try {
    return await client.getLogs({ address, event: transfer, args, fromBlock, toBlock });
  } catch (error) {
    if (toBlock - fromBlock < 1_000n) throw error;
    const middle = (fromBlock + toBlock) / 2n;
    const left = await getLogsBatched(client, address, args, fromBlock, middle);
    const right = await getLogsBatched(client, address, args, middle + 1n, toBlock);
    return left.concat(right);
  }
}

export function purchaseFromReceipt(receipt, ticker, wallet, expectedQuantity) {
  const route = POOLS[ticker];
  if (receipt.status !== 'success' || !isAddressEqual(receipt.from, wallet) ||
      !receipt.to || !isAddressEqual(receipt.to, V3_ROUTER)) {
    throw new Error(`${ticker} acquisition transaction is not a confirmed agent swap`);
  }
  let spent = 0n;
  let received = 0n;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, USDG) && !isAddressEqual(log.address, route.token)) continue;
    let entry;
    try { entry = decodeEventLog({ abi: [transfer], data: log.data, topics: log.topics }); }
    catch { continue; }
    if (isAddressEqual(log.address, USDG) &&
        isAddressEqual(entry.args.from, wallet) && isAddressEqual(entry.args.to, route.pool)) {
      spent += entry.args.value;
    }
    if (isAddressEqual(log.address, route.token) &&
        isAddressEqual(entry.args.from, route.pool) && isAddressEqual(entry.args.to, wallet)) {
      received += entry.args.value;
    }
  }
  if (spent <= 0n || received !== expectedQuantity) {
    throw new Error(`${ticker} acquisition receipt does not match its USDG spend and token receipt`);
  }
  return spent;
}

// Rebuilds actual purchase quantities and USDG paid from confirmed router receipts.
// A transfer from another source cannot become a zero-cost position: the caller
// must compare acquired less confirmed exits with the current wallet balance.
export async function scanAcquisitions(wallet, {
  client = publicClient, path = defaultPath, throughBlock = null,
} = {}) {
  if (await client.getChainId() !== CHAIN_ID) throw new Error('Wrong chain for exit acquisition scan');
  const latest = throughBlock === null ? await client.getBlockNumber() : BigInt(throughBlock);
  const finalized = latest > 12n ? latest - 12n : latest;
  let state = read(path, wallet);
  if (!state) {
    const first = await firstBlockAtOrAfter(firstPossibleBuy, finalized, client);
    state = { version: 1, wallet, throughBlock: Number(first - 1n),
      AAPL: { quantity: '0', spentUsdg: '0' }, NVDA: { quantity: '0', spentUsdg: '0' } };
  }
  const fromBlock = BigInt(state.throughBlock) + 1n;
  if (fromBlock > finalized) return state;
  const next = structuredClone(state);
  for (const ticker of WATCHLIST) {
    const route = POOLS[ticker];
    const logs = await getLogsBatched(client, route.token,
      { from: route.pool, to: wallet }, fromBlock, finalized);
    let quantity = BigInt(next[ticker].quantity);
    let spent = BigInt(next[ticker].spentUsdg);
    const seen = new Set();
    for (const log of logs) {
      if (seen.has(log.transactionHash)) throw new Error(`Multiple ${ticker} receipts in one swap`);
      seen.add(log.transactionHash);
      const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
      spent += purchaseFromReceipt(receipt, ticker, wallet, log.args.value);
      quantity += log.args.value;
    }
    next[ticker] = { quantity: quantity.toString(), spentUsdg: spent.toString() };
  }
  next.throughBlock = Number(finalized);
  save(path, next);
  return next;
}
