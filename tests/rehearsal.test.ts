import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runRehearsal, rehearsalMandateSchema, REHEARSAL_SCENARIOS, hashRecord } from '../apps/web/src/rehearsal.js';
import { createWebServer, sampleMarketState } from '../apps/web/src/server.js';
import { cachedReader } from '../apps/web/src/cached-provider.js';
import { PythProMarketClient } from '../services/arbitrage-mcp/src/pyth-pro.js';
import { AAPL_MARKETS } from '../services/arbitrage-mcp/src/markets.js';
import { readMarketState } from '../services/arbitrage-mcp/src/scanner.js';
import { readGovernanceSnapshot } from '../packages/dao-client/src/governance.js';

test('policy rehearsal passes bounded case, rejects each unsafe case, and never grants execution', () => {
  for (const scenario of REHEARSAL_SCENARIOS) {
    const result = runRehearsal(scenario, 1_790_000_000_000);
    assert.equal(result.policyDecision, scenario === 'within-limits' ? 'PRECHECK_PASS' : 'REJECT', scenario);
    assert.equal(result.execution.authorized, false);
    assert.equal(result.execution.transactionSignature, null);
    assert.equal(result.execution.fundsMoved, false);
    assert.equal(result.source, 'synthetic-fixtures');
    const { recordHash, ...payload } = result;
    assert.equal(hashRecord(payload), recordHash);
    assert.notEqual(hashRecord({ ...payload, policyDecision: 'FORGED' }), recordHash);
  }
});

test('mandate schema rejects overspending, fractional raw amounts and authority injection', () => {
  const valid = runRehearsal('within-limits').manifest;
  assert.equal(rehearsalMandateSchema.safeParse(valid).success, true);
  for (const patch of [{ maxTradeUsdcRaw: '100000001' }, { budgetUsdcRaw: '1.5' }, { execute: true }, { maximumSlippageBps: -1 }]) {
    assert.equal(rehearsalMandateSchema.safeParse({ ...valid, ...patch }).success, false);
  }
});

test('HTTP rehearsal exposes exact records, rejects arbitrary scenarios, and accepts no signing requests', async () => {
  const server = createWebServer({ read: async () => sampleMarketState() }, 'sample');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const scenario of REHEARSAL_SCENARIOS) {
      const res = await fetch(`${base}/api/demo/rehearsal?scenario=${scenario}`);
      assert.equal(res.status, 200); const record = await res.json();
      assert.equal(record.execution.authorized, false); assert.equal(record.scenario, scenario);
    }
    assert.equal((await fetch(`${base}/api/demo/rehearsal?scenario=execute`)).status, 400);
    assert.equal((await fetch(`${base}/api/demo/rehearsal`, { method: 'POST', body: '{}' })).status, 405);
    for (const path of ['/demo', '/demo.css', '/demo.js']) assert.equal((await fetch(base + path)).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('shared reads coalesce concurrent calls and never return expired cache after a failure', async () => {
  let calls = 0;
  const read = cachedReader(async () => { calls++; await new Promise(r => setTimeout(r, 5)); if (calls > 1) throw new Error('offline'); return 'live'; }, 5);
  assert.deepEqual(await Promise.all([read(), read(), read()]), ['live', 'live', 'live']); assert.equal(calls, 1);
  await new Promise(r => setTimeout(r, 10));
  await assert.rejects(read(), /offline/); assert.equal(calls, 2);
});

test('Pyth entitlement errors stay visible and cannot become sample prices or executable signals', async () => {
  const client = new PythProMarketClient('test', async () => new Response('Not entitled', { status: 403 }));
  await assert.rejects(client.fetchLatest(AAPL_MARKETS.equity), /PYTH_FEED_NOT_ENTITLED/);
  const state = await readMarketState(client);
  assert.equal(state.markets.every(row => !row.price && row.issues.includes('PYTH_FEED_NOT_ENTITLED')), true);
});

test('governance read rejects untrusted account owners before decoding proposal data', async () => {
  await assert.rejects(readGovernanceSnapshot('https://rpc.example', async () => new Response(JSON.stringify({ result: {
    context: { slot: 123 }, value: { owner: 'attacker', executable: false, data: ['AAAA', 'base64'] },
  } }))), /Invalid governance account/);
});
