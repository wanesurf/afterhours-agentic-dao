import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portfolioPerformance } from '../public/portfolio-performance.js';

const emptyExits = { available: true, totalAcquisitionUsdg: '0', totalProceedsUsdg: '0',
  totalVerifiedAcquisitionUsdg: '3325' };

test('current pool sale estimates show gross unrealized trading P/L without a 10% close assumption', () => {
  const result = portfolioPerformance({ valuationComplete: true, stocks: [
    { ticker: 'NVDA', quantity: '6.86', estimatedSellUsdg: '1540.761549' },
    { ticker: 'AAPL', quantity: '5.41', estimatedSellUsdg: '1812.267854' },
  ] }, emptyExits);
  assert.deepEqual(result, {
    estimatedGrossTradingPnlUsdg: '28.029403',
    realizedGrossTradingPnlUsdg: '0',
  });
});

test('confirmed sale proceeds contribute once while remaining stock stays marked to its pool quote', () => {
  const result = portfolioPerformance({ valuationComplete: true, stocks: [
    { ticker: 'AAPL', quantity: '5.41', estimatedSellUsdg: '1812.267854' },
    { ticker: 'NVDA', quantity: '0', estimatedSellUsdg: '0' },
  ] }, {
    available: true, totalAcquisitionUsdg: '1515', totalProceedsUsdg: '1539.509907',
    totalVerifiedAcquisitionUsdg: '3325',
  });
  assert.deepEqual(result, {
    estimatedGrossTradingPnlUsdg: '26.777761',
    realizedGrossTradingPnlUsdg: '24.509907',
  });
});

test('fully sold positions use confirmed sale costs even if the old dashboard buy counter missed a buy', () => {
  const result = portfolioPerformance({ valuationComplete: true, stocks: [
    { ticker: 'NVDA', quantity: '0', estimatedSellUsdg: '0' },
    { ticker: 'AAPL', quantity: '0', estimatedSellUsdg: '0' },
  ] }, { available: true, totalAcquisitionUsdg: '3325', totalProceedsUsdg: '3354.754473',
    totalVerifiedAcquisitionUsdg: null });
  assert.deepEqual(result, {
    estimatedGrossTradingPnlUsdg: '29.754473',
    realizedGrossTradingPnlUsdg: '29.754473',
  });
});

test('missing sell quote or exit ledger withholds the trading P/L', () => {
  const portfolio = { valuationComplete: true, stocks: [{ ticker: 'AAPL', quantity: '1', estimatedSellUsdg: null }] };
  assert.equal(portfolioPerformance(portfolio, emptyExits), null);
  const quoted = { ...portfolio, stocks: [{ ticker: 'AAPL', quantity: '1', estimatedSellUsdg: '6' }] };
  assert.equal(portfolioPerformance(quoted, { available: false }), null);
  assert.equal(portfolioPerformance(quoted, { ...emptyExits, pendingCount: 1 }), null);
  assert.equal(portfolioPerformance(quoted, { ...emptyExits, totalVerifiedAcquisitionUsdg: null }), null);
  assert.equal(portfolioPerformance(quoted, { ...emptyExits, totalAcquisitionUsdg: '4000' }), null);
});
