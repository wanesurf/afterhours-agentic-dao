import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ogTreasurySnapshot, renderTreasuryOg } from '../src/og-image.js';

test('OG image shows a checked portfolio estimate and changes with its value', async () => {
  const portfolio = {
    treasuryValuationComplete: true,
    estimatedTreasuryUsdg: '3653.44',
    checkedAt: '2026-09-21T13:47:00.000Z',
  };
  const first = ogTreasurySnapshot(portfolio);
  assert.equal(first.amount, '$3,653.44');
  assert.equal(first.version, String(Date.parse(portfolio.checkedAt)));
  const second = ogTreasurySnapshot({ ...portfolio, estimatedTreasuryUsdg: '4000.00', checkedAt: '2026-09-21T13:48:00.000Z' });
  const [firstImage, secondImage] = await Promise.all([renderTreasuryOg(first), renderTreasuryOg(second)]);
  assert.notDeepEqual(firstImage, secondImage);
  assert.deepEqual([firstImage.readUInt32BE(16), firstImage.readUInt32BE(20)], [1200, 630]);
  assert.equal(ogTreasurySnapshot({ ...portfolio, treasuryValuationComplete: false }).amount, null);
  assert.equal(ogTreasurySnapshot({ ...portfolio, estimatedTreasuryUsdg: null }).version, 'unavailable');
});
