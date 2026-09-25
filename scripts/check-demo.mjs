import { createHash } from 'node:crypto';
const arg = process.argv.slice(2).find(value => value.startsWith('http'));
const base = new URL(arg || 'http://localhost:8786').origin;
const strictLive = process.argv.includes('--require-live');
const checks = [];
async function check(name, fn) { try { const detail = await fn(); checks.push({ name, status: detail?.ready === false ? 'BLOCKED' : 'PASS', detail }); } catch(error) { checks.push({ name, status: 'FAIL', detail: error.message }); } }
async function get(path) { const response = await fetch(base + path, { signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response; }
const expect = (value, message) => { if (!value) throw new Error(message); };
await check('Web and demo assets', async () => { for (const path of ['/health', '/demo', '/demo.js', '/demo.css']) await get(path); return base; });
await check('Finalized DAO governance', async () => {
  const data = await (await get('/api/governance')).json();
  expect(data.source === 'solana-mainnet' && data.commitment === 'finalized', 'Missing chain provenance');
  expect(data.realm === 'HLbzfAQP4b5oFBh8CeQ6DQSX1zr8kjjejxuywU2yYeCK', 'Unexpected Realm');
  return { proposals: data.proposals.map(p => ({ name: p.name, state: p.state, population: p.population })), votingSeconds: data.votingSeconds, slots: data.finalizedSlots };
});
await check('Market feed availability', async () => {
  const data = await (await get('/api/markets')).json();
  expect(data.state.profile?.symbols.length > 0 && data.state.markets.length === data.state.profile.symbols.length, 'Missing configured feed rows');
  expect(data.state.markets.every((row, index) => row.symbol === data.state.profile.symbols[index]), 'Unexpected feed set');
  if (data.state.profile.id === 'free-trial') expect(data.state.basis.every(pair => pair.baseSymbol === 'Crypto.BTC/USD' && pair.comparisonSymbol === 'Crypto.WBTC/USD'), 'Unrelated assets compared');
  const issues = data.state.markets.map(row => ({ symbol: row.symbol, available: Boolean(row.price), issues: row.issues }));
  if (strictLive) expect(data.mode === 'live' && issues.every(row => row.available && row.issues.length === 0), JSON.stringify(issues));
  return { profile: data.state.profile.id, mode: data.mode, ready: data.mode === 'live' && issues.every(row => row.available && row.issues.length === 0), feeds: issues };
});
for (const scenario of ['within-limits', 'over-budget', 'stale-price', 'paused', 'expired', 'no-discount']) await check(`Policy case: ${scenario}`, async () => {
  const record = await (await get(`/api/demo/rehearsal?scenario=${scenario}`)).json();
  expect(record.policyDecision === (scenario === 'within-limits' ? 'PRECHECK_PASS' : 'REJECT'), 'Unexpected policy decision');
  expect(record.source === 'synthetic-fixtures' && record.execution.authorized === false && record.execution.transactionSignature === null && record.execution.fundsMoved === false, 'Rehearsal crossed execution boundary');
  const { recordHash, ...body } = record; expect(createHash('sha256').update(JSON.stringify(body)).digest('hex') === recordHash, 'Record digest mismatch');
  return { decision: record.policyDecision, reasons: record.reasons, recordHash };
});
await check('Anonymous chat readiness', async () => {
  const response = await fetch(base + '/api/chat/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  expect(response.ok, `Chat session HTTP ${response.status}`); const session = await response.json();
  if (strictLive) expect(session.agentConfigured, 'Hermes API is not configured');
  return { ready: session.agentConfigured, agentConfigured: session.agentConfigured, access: session.access, completionTested: false };
});
checks.push({ name: 'Funded vault execution and settlement', status: 'BLOCKED', detail: 'No approved strategy, isolated vault, live quote, simulator, signer or return path is connected.' });
const report = { checkedAt: new Date().toISOString(), base, strictLive, checks,
  execution: 'NOT_CONNECTED', fullFundedVaultDemoReady: false };
console.log(JSON.stringify(report, null, 2));
if (checks.some(check => check.status === 'FAIL' || (strictLive && check.status === 'BLOCKED'))) process.exitCode = 1;
