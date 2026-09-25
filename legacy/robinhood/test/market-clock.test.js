import test from 'node:test';
import assert from 'node:assert/strict';
import { countdownParts, marketClock } from '../public/market-clock.js';

test('counts down from the weekend to the Monday NYSE open', () => {
  const result = marketClock(new Date('2026-09-20T12:00:00Z'));
  assert.equal(result.state, 'countdown');
  assert.equal(new Date(result.opensAt).toISOString(), '2026-09-21T13:30:00.000Z');
});

test('switches to open at 9:30 AM Eastern and advances after the close', () => {
  assert.equal(marketClock(new Date('2026-09-21T13:29:59Z')).state, 'countdown');
  assert.equal(marketClock(new Date('2026-09-21T13:30:00Z')).state, 'open');
  const afterClose = marketClock(new Date('2026-09-21T20:00:00Z'));
  assert.equal(afterClose.state, 'countdown');
  assert.equal(new Date(afterClose.opensAt).toISOString(), '2026-09-22T13:30:00.000Z');
});

test('skips NYSE holidays and recognizes the early close', () => {
  const laborDay = marketClock(new Date('2026-09-07T13:00:00Z'));
  assert.equal(new Date(laborDay.opensAt).toISOString(), '2026-09-08T13:30:00.000Z');
  const goodFriday = marketClock(new Date('2026-04-03T13:00:00Z'));
  assert.equal(new Date(goodFriday.opensAt).toISOString(), '2026-04-06T13:30:00.000Z');
  assert.equal(marketClock(new Date('2026-11-27T17:59:00Z')).state, 'open');
  const afterEarlyClose = marketClock(new Date('2026-11-27T18:00:00Z'));
  assert.equal(new Date(afterEarlyClose.opensAt).toISOString(), '2026-11-30T14:30:00.000Z');
});

test('uses the Eastern daylight-saving change for opening time', () => {
  const result = marketClock(new Date('2026-11-01T12:00:00Z'));
  assert.equal(new Date(result.opensAt).toISOString(), '2026-11-02T14:30:00.000Z');
});

test('formats remaining time with whole seconds', () => {
  assert.deepEqual(countdownParts(90061000), { days: 1, clock: '01:01:01' });
  assert.deepEqual(countdownParts(0), { days: 0, clock: '00:00:00' });
});
