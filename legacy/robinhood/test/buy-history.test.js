import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';
import { scanBuyHistory, publicBuyHistory, readBuyHistory } from '../src/buy-history.js';
import { firstPossibleBuy } from '../src/exit-basis.js';
import { CHAIN_ID, USDG } from '../src/config.js';
import { POOLS, V3_ROUTER } from '../src/v3.js';

const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const wallet = '0x1111111111111111111111111111111111111111';
const hash = '0x' + 'a'.repeat(64);

function transferLog(address, from, to, value) {
  return { address, topics: encodeEventTopics({ abi: [transfer], eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}

test('read-only index reconstructs every confirmed agent buy and resumes without duplicates', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterhours-buy-index-'));
  const file = join(directory, 'buys.json');
  const route = POOLS.AAPL;
  const quantity = 25_000000000000000n;
  const spent = 5_000000n;
  const log = { address: route.token, args: { value: quantity }, transactionHash: hash, blockNumber: 10n };
  const receipt = { transactionHash: hash, blockNumber: 10n, status: 'success', from: wallet, to: V3_ROUTER,
    gasUsed: 100000n, effectiveGasPrice: 1000000000n,
    logs: [transferLog(USDG, wallet, route.pool, spent), transferLog(route.token, route.pool, wallet, quantity)] };
  const client = {
    getChainId: async () => CHAIN_ID,
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(firstPossibleBuy + Number(blockNumber)) }),
    getLogs: async ({ address, fromBlock, toBlock }) =>
      address.toLowerCase() === route.token.toLowerCase() && fromBlock <= 10n && toBlock >= 10n ? [log] : [],
    getTransactionReceipt: async () => receipt,
  };
  try {
    const first = await scanBuyHistory(wallet, { client, file, throughBlock: 30n });
    assert.equal(first.throughBlock, 18);
    assert.equal(first.buys.length, 1);
    assert.equal(first.buys[0].spentUsdg, spent.toString());
    assert.equal(first.buys[0].quantity, quantity.toString());
    assert.equal(first.buys[0].gasWei, '100000000000000');
    const publicAapl = publicBuyHistory(wallet, 'AAPL', file);
    assert.equal(publicAapl.buys[0].spentUsdg, '5');
    assert.equal(publicAapl.buys[0].quantity, '0.025');
    assert.deepEqual(publicBuyHistory(wallet, 'NVDA', file).buys, []);
    assert.equal(publicBuyHistory(wallet, 'FAKE', file), null);
    const second = await scanBuyHistory(wallet, { client, file, throughBlock: 40n });
    assert.equal(second.throughBlock, 28);
    assert.equal(second.buys.length, 1);
    await assert.rejects(scanBuyHistory(wallet, {
      client: { ...client, getTransactionReceipt: async () => ({ ...receipt, from: '0x2222222222222222222222222222222222222222' }) },
      file: join(directory, 'invalid.json'), throughBlock: 30n,
    }), /not a confirmed agent swap/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('historical receipt scan checkpoints completed block ranges before an RPC failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterhours-buy-checkpoint-'));
  const file = join(directory, 'buys.json');
  const calls = [];
  const client = {
    getChainId: async () => CHAIN_ID,
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(firstPossibleBuy + Number(blockNumber)) }),
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock]);
      if (fromBlock >= 2000n) throw new Error('RPC unavailable');
      return [];
    },
  };
  try {
    await assert.rejects(scanBuyHistory(wallet, { client, file, throughBlock: 4025n }), /RPC unavailable/);
    assert.equal(readBuyHistory(wallet, file).throughBlock, 1999);
    calls.length = 0;
    const resumed = await scanBuyHistory(wallet, {
      client: { ...client, getLogs: async ({ fromBlock, toBlock }) => {
        calls.push([fromBlock, toBlock]);
        return [];
      } }, file, throughBlock: 4025n,
    });
    assert.equal(resumed.throughBlock, 4013);
    assert.equal(calls[0][0], 2000n);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
