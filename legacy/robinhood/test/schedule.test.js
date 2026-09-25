import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCycleDelay } from '../src/schedule.js';

test('a Railway restart waits for the next five-minute check', () => {
  const now = Date.parse('2026-09-20T08:00:00Z');
  assert.equal(nextCycleDelay({ lastStartedAt: null, lastCompletedAt: null }, 5, now), 0);
  assert.equal(nextCycleDelay({ lastStartedAt: '2026-09-20T07:58:00Z',
    lastCompletedAt: '2026-09-20T07:58:30Z' }, 5, now), 210_000);
  assert.equal(nextCycleDelay({ lastStartedAt: '2026-09-20T07:59:00Z',
    lastCompletedAt: '2026-09-20T07:58:30Z' }, 5, now), 240_000);
  assert.equal(nextCycleDelay({ lastStartedAt: '2026-09-20T07:50:00Z',
    lastCompletedAt: '2026-09-20T07:50:30Z' }, 5, now), 0);
});
