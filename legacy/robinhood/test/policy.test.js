import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';
import { candidates, screenBoard, executionFloor, routeDiscount, validatePaidSignal } from '../src/policy.js';

const now = Date.parse('2026-09-20T03:00:00Z');
const c = { maxSignalAgeSeconds: 45, maxCloseAgeDays: 4, minDiscount: 2, minExecutionDiscount: 1, maxRouteMarkup: 1, maxSlippage: 0.25 };
const signal = { ticker: 'AAPL', nyseOpenNow: false, asOf: new Date(now).toISOString(), lastNyseCloseDate: '2026-09-18', lastNyseClose: 100, onchainPrice: 97, discountPct: 3, source: { chain: 'Robinhood Chain (eip155:4663)' } };

test('board screens for fresh after-hours tradable dips', () => {
  const board = { nyseOpenNow: false, asOf: signal.asOf, prices: [
    { ticker: 'AAPL', tradable: true, onchain: 97, close: 100, closeDate: '2026-09-18', discount: 3 },
    { ticker: 'MU', tradable: false, close: 100, closeDate: '2026-09-18', discount: 8 },
  ] };
  assert.deepEqual(candidates(board, c, now).map(s => s.ticker), ['AAPL']);
  assert.deepEqual(candidates({ ...board, nyseOpenNow: true }, c, now), []);
  assert.deepEqual(candidates({ ...board, asOf: '2026-09-19T01:00:00Z' }, c, now), []);
  const explained = screenBoard(board, c, now);
  assert.deepEqual(explained.filter(row => row.eligible).map(row => row.ticker), ['AAPL']);
  assert.ok(explained.find(row => row.ticker === 'NVDA').reasons.includes('No price in the Oracle board'));
  assert.ok(screenBoard({ ...board, nyseOpenNow: true }, c, now).every(row => !row.eligible));
});

test('paid signal rejects stale and market-open responses', () => {
  assert.doesNotThrow(() => validatePaidSignal(signal, 'AAPL', c, now));
  assert.throws(() => validatePaidSignal({ ...signal, nyseOpenNow: true }, 'AAPL', c, now));
  assert.throws(() => validatePaidSignal(signal, 'AMD', c, now));
  assert.throws(() => validatePaidSignal({ ...signal, asOf: '2026-09-18T03:00:00Z' }, 'AAPL', c, now));
  // The paid Oracle's v4 pool spot is not the executable v3 price.
  assert.doesNotThrow(() => validatePaidSignal({ ...signal, onchainPrice: 200, discountPct: -100 }, 'AAPL', c, now));
});

test('approved pool quote must meet the discount against the paid close', () => {
  assert.ok(routeDiscount(97, 100, c) >= 2);
  assert.throws(() => routeDiscount(99, 100, c));
  assert.throws(() => routeDiscount(NaN, 100, c));
});

test('minimum output fixes a maximum executed price even if route moves', () => {
  const amount = parseUnits('5', 6);
  const out = parseUnits('0.0511', 18); // about 97.85 USDG per token
  const floor = executionFloor(signal, amount, out, c);
  assert.ok(floor.minOut <= out);
  assert.ok(5 / Number(floor.minOut) * 1e18 < 99.01);
  assert.throws(() => executionFloor(signal, amount, parseUnits('0.049', 18), c));
});

test('0.6% screen and execution floor use the same close threshold', () => {
  const rule = { ...c, minDiscount: 0.6, minExecutionDiscount: 0.6 };
  const close = 336.13;
  const quotePrice = 333.5;
  assert.ok(routeDiscount(quotePrice, close, rule) > 0.6);
  const amount = parseUnits('5', 6);
  const output = parseUnits((5 / quotePrice).toFixed(18), 18);
  const { minOut } = executionFloor({ lastNyseClose: close, onchainPrice: quotePrice }, amount, output, rule);
  assert.ok(5 / Number(minOut) * 1e18 <= close * 0.994 + 0.00001);
  assert.throws(() => routeDiscount(334.48, close, rule));
  assert.throws(() => executionFloor({ lastNyseClose: close, onchainPrice: quotePrice },
    amount, parseUnits((5 / 334.48).toFixed(18), 18), rule));
});
