import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('live Stock Token trading requires explicit eligibility acknowledgment', () => {
  const command = ['--input-type=module', '-e', "import './src/config.js'"];
  const blocked = spawnSync(process.execPath, command, {
    cwd: process.cwd(), env: { LIVE_TRADING: 'true' }, encoding: 'utf8',
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /STOCK_TOKEN_ELIGIBILITY_CONFIRMED=true/);

  const acknowledged = spawnSync(process.execPath, command, {
    cwd: process.cwd(),
    env: { LIVE_TRADING: 'true', STOCK_TOKEN_ELIGIBILITY_CONFIRMED: 'true' },
    encoding: 'utf8',
  });
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
});
