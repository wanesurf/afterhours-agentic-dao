import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnits } from 'viem';
import { loadOrCaptureExitBenchmark, rememberPreopenPortfolio } from '../src/exit-benchmark.js';

const wallet = '0x141B4102b22457D397EBeB69fa6ea052F604C9b1';
const opening = Date.parse('2026-09-21T13:30:05Z');
const orders = { AAPL: { soldQuantity: '0' }, NVDA: { soldQuantity: '0' } };
const snapshot = {
  wallet, checkedAt: '2026-09-21T13:29:25Z', valuationComplete: true,
  cashUsdg: '180', estimatedTotalUsdg: '3510',
  stocks: [
    { ticker: 'AAPL', quantity: '5.5', estimatedSellUsdg: '1800' },
    { ticker: 'NVDA', quantity: '6.8', estimatedSellUsdg: '1530' },
  ],
};

test('locks the last complete pre-open treasury value and ignores later moving estimates', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'afterhours-benchmark-')), 'benchmark.json');
  const original = loadOrCaptureExitBenchmark(wallet, snapshot, orders, opening, path);
  assert.equal(original.totalUsdg, parseUnits('3510', 6).toString());
  assert.equal(original.positions.AAPL.quantity, parseUnits('5.5', 18).toString());
  const changed = { ...snapshot, checkedAt: '2026-09-21T13:31:00Z',
    estimatedTotalUsdg: '9999' };
  assert.deepEqual(loadOrCaptureExitBenchmark(wallet, changed, orders, opening + 60_000, path), original);
});

test('missing, stale, or incomplete pre-open valuation cannot establish a sell target', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'afterhours-benchmark-')), 'benchmark.json');
  assert.throws(() => loadOrCaptureExitBenchmark(wallet,
    { ...snapshot, checkedAt: '2026-09-21T13:10:00Z' }, orders, opening, path), /No fresh/);
  assert.throws(() => loadOrCaptureExitBenchmark(wallet,
    { ...snapshot, valuationComplete: false }, orders, opening, path), /No fresh/);
  assert.throws(() => loadOrCaptureExitBenchmark(wallet,
    { ...snapshot, estimatedTotalUsdg: '3400' }, orders, opening, path), /inconsistent/);
});

test('uses the saved pre-open valuation after a slow opening check overwrites the live snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterhours-benchmark-'));
  const benchmarkPath = join(directory, 'benchmark.json');
  const preopenPath = join(directory, 'preopen.json');
  assert.equal(rememberPreopenPortfolio(snapshot,
    { nyseOpenNow: false, asOf: '2026-09-21T13:29:20Z' }, preopenPath), true);
  assert.equal(rememberPreopenPortfolio({ ...snapshot, checkedAt: '2026-09-21T13:30:01Z' },
    { nyseOpenNow: false, asOf: '2026-09-21T13:30:00Z' }, preopenPath), false);
  const openMarketSnapshot = { ...snapshot, checkedAt: '2026-09-21T13:31:00Z',
    estimatedTotalUsdg: '9999' };
  const saved = loadOrCaptureExitBenchmark(wallet, openMarketSnapshot, orders,
    opening + 120_000, benchmarkPath, preopenPath);
  assert.equal(saved.totalUsdg, parseUnits('3510', 6).toString());
  assert.equal(saved.capturedAt, snapshot.checkedAt);
});
