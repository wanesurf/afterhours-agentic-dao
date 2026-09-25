import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import bs58 from 'bs58';
import { HolderAuth, createBalanceReader, HOLDER_MINT } from '../apps/web/src/auth/holder-auth.js';
import { ChatSessions, CHAT_SESSION_TTL_MS } from '../apps/web/src/chat-sessions.js';
import { createHermesRuntime } from '../apps/web/src/hermes-runtime.js';
import { createWebServer, sampleMarketState } from '../apps/web/src/server.js';
import { AFTERHOURS_DAO } from '../packages/dao-client/src/deployed-dao.js';

const origin = 'http://localhost:8785';
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = bs58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address, signature: (message: string) => sign(null, Buffer.from(message), privateKey).toString('base64') };
}
async function login(auth: HolderAuth, who = wallet()) {
  const challenge = auth.challenge(who.address);
  return auth.authenticate(challenge.id, who.signature(challenge.message), challenge.binding);
}
test('strict threshold denies 0 and exactly 1 token, admits 1.000001', async () => {
  for (const raw of [0n, 999_999n, 1_000_000n]) {
    await assert.rejects(login(new HolderAuth(origin, async () => raw)), /more than 1/);
  }
  assert.equal((await login(new HolderAuth(origin, async () => 1_000_001n))).rawBalance, '1000001');
});
test('challenge binds origin, wallet, browser, expiry and cannot replay, even concurrently', async () => {
  let now = Date.now(); const who = wallet(); const auth = new HolderAuth(origin, async () => 2_000_000n, () => now);
  const challenge = auth.challenge(who.address);
  assert.ok(challenge.message.includes(`URI: ${origin}`));
  assert.ok(challenge.message.includes('Chain ID: solana:mainnet'));
  await assert.rejects(auth.authenticate(challenge.id, who.signature(challenge.message), 'wrong-browser'), /expired/);
  await assert.rejects(auth.authenticate(challenge.id, who.signature(challenge.message.replace(origin, 'https://evil.example')), challenge.binding), /signature/);
  await assert.rejects(auth.authenticate(challenge.id, who.signature(challenge.message), challenge.binding), /expired/);
  const concurrent = auth.challenge(who.address);
  const results = await Promise.allSettled([1,2].map(() => auth.authenticate(concurrent.id, who.signature(concurrent.message), concurrent.binding)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const expired = auth.challenge(who.address); now += 300_001;
  await assert.rejects(auth.authenticate(expired.id, who.signature(expired.message), expired.binding), /expired/);
  const wrongWallet = auth.challenge(who.address);
  await assert.rejects(auth.authenticate(wrongWallet.id, wallet().signature(wrongWallet.message), wrongWallet.binding), /signature/);
});
test('session expires and loses access after tokens leave; RPC errors never admit a holder', async () => {
  let raw = 2_000_000n, now = Date.now(); const auth = new HolderAuth(origin, async () => raw, () => now);
  const session = await login(auth); raw = 1_000_000n;
  await assert.rejects(auth.checkBalance(session), /no longer/);
  assert.throws(() => auth.session(session.id), /Connect/);
  raw = 2_000_000n; const next = await login(auth); now += 3_600_001;
  assert.throws(() => auth.session(next.id), /Connect/);
  await assert.rejects(login(new HolderAuth(origin, async () => { throw new Error('RPC down'); })), /RPC down/);
});
test('all Token-2022 accounts are summed exactly; malformed or mismatched RPC data fails closed', async () => {
  const who = wallet();
  const row = (amount: string) => ({ pubkey: wallet().address, account: { owner: AFTERHOURS_DAO.token2022Program, executable: false,
    data: { parsed: { type: 'account', info: { mint: String(HOLDER_MINT), owner: who.address, state: 'initialized', tokenAmount: { amount, decimals: 6 } } } } } });
  let rows = [row('600000'), row('600001')];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    assert.equal(request.method, 'getTokenAccountsByOwner');
    assert.equal(request.params[1].mint, HOLDER_MINT);
    assert.equal(request.params[2].commitment, 'finalized');
    return Response.json({ result: { context: { slot: 123 }, value: rows } });
  }) as typeof fetch;
  const read = createBalanceReader('https://rpc.example', fetcher);
  assert.equal(await read(who.address), 1_200_001n);
  rows = [row('9007199254740993')]; assert.equal(await read(who.address), 9007199254740993n);
  rows[0].account.data.parsed.info.mint = who.address;
  await assert.rejects(read(who.address), /unavailable/);
  rows = [row('2000000')]; rows.push(rows[0]);
  await assert.rejects(read(who.address), /unavailable/);
});
test('Hermes proxy uses the main advertised model and enforces read-only tools', async () => {
  let toolsets: unknown = [{ enabled: false, tools: ['terminal'] }], calls = 0;
  let models: unknown = { data: [{ id: 'hermes-agent' }] };
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith('https://agent.example/v1/'));
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test-secret');
    if (url.endsWith('/v1/models')) return Response.json(models);
    if (url.endsWith('/v1/toolsets')) return Response.json(toolsets);
    calls++; const body = JSON.parse(init.body as string);
    assert.equal(body.messages[0].role, 'system'); assert.match(body.messages[0].content, /sample evidence/);
    assert.equal(body.messages[1].role, 'user'); assert.equal(body.model, 'hermes-agent');
    assert.equal((init.headers as Record<string, string>)['X-Hermes-Session-Key'], 'afterhours:public:private-conversation');
    return Response.json({ choices: [{ message: { content: 'A read-only answer.' } }] });
  }) as typeof fetch;
  const runtime = createHermesRuntime('https://agent.example', 'test-secret', { fetcher });
  assert.equal(await runtime.reply([{role:'user',content:'Hello'}], 'private-conversation', 'sample evidence'), 'A read-only answer.');
  assert.equal(calls, 1);
  toolsets = [{ enabled: true, tools: ['execute_trade'] }];
  await assert.rejects(runtime.reply([], 'id', ''), /unavailable/); assert.equal(calls, 1);
  toolsets = {}; await assert.rejects(runtime.reply([], 'id', ''), /unavailable/);
  toolsets = [];
  for (const data of [[], [{ id: 'first' }, { id: 'second' }], [null], [{ id: '' }]]) {
    models = { data }; await assert.rejects(runtime.reply([], 'id', ''), /unavailable/);
  }
  assert.equal(calls, 1);
  assert.equal(createHermesRuntime().configured, false);
});
test('Hermes model override must match discovery and stays server-controlled', async () => {
  let calls = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'default' }, { id: 'another' }] });
    if (url.endsWith('/v1/toolsets')) return Response.json([]);
    calls++;
    assert.equal(JSON.parse(init.body as string).model, 'default');
    return Response.json({ choices: [{ message: { content: 'Main agent reply.' } }] });
  }) as typeof fetch;
  const runtime = createHermesRuntime('https://agent.example', 'test-secret', { model: 'default', fetcher });
  assert.equal(await runtime.reply([], 'id', ''), 'Main agent reply.');
  const wrong = createHermesRuntime('https://agent.example', 'test-secret', { model: 'unknown', fetcher });
  await assert.rejects(wrong.reply([], 'id', ''), /unavailable/);
  assert.equal(calls, 1);
});
test('anonymous sessions expire, ignore unknown IDs, and reset the upstream conversation', () => {
  let now = Date.now(); const sessions = new ChatSessions(() => now);
  const one = sessions.create(), two = sessions.create();
  assert.notEqual(one.id, two.id); assert.notEqual(one.id, one.conversationId);
  assert.equal(sessions.find('client-chosen-id'), undefined);
  one.messages.push({ role: 'user', content: 'My question' });
  const previous = one.conversationId;
  one.busy = true; assert.throws(() => sessions.reset(one), /Wait/);
  one.busy = false; sessions.reset(one);
  assert.notEqual(one.conversationId, previous); assert.deepEqual(one.messages, []);
  now += CHAT_SESSION_TTL_MS;
  assert.throws(() => sessions.get(one.id), /expired/);
});

test('public chat needs no wallet, isolates browser histories, rejects origin/authority overrides and preserves rate limits', async () => {
  let replies = 0;
  const conversations: string[] = [];
  const runtime = { configured: true, reply: async (messages: {role:string;content:string}[], conversationId: string) => {
    replies++; conversations.push(conversationId); return `You asked: ${messages.at(-1)?.content}`;
  } };
  const server = createWebServer({read: async () => sampleMarketState()}, 'sample', { origin, runtime, evidence: async () => 'sample' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, data?: unknown, cookie = '', requestOrigin = origin) => fetch(`${base}${path}`, {
    method: data === undefined ? 'GET' : 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json', cookie }, body: data === undefined ? undefined : JSON.stringify(data) });
  const open = async () => {
    const res = await request('/api/chat/session', {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(res.headers.get('set-cookie')!, /SameSite=Strict/);
    const data = await res.json();
    assert.equal(data.access, 'public'); assert.equal(data.agentConfigured, true);
    assert.equal(data.walletAddress, undefined); assert.equal(data.id, undefined);
    return res.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  };
  try {
    assert.equal((await request('/api/chat/session', {}, '', 'https://evil.example')).status, 403);
    assert.equal((await request('/api/chat/session', {walletAddress:wallet().address})).status, 400);
    assert.equal((await request('/api/auth/challenge', {walletAddress:wallet().address})).status, 404);
    assert.equal((await request('/api/chat', undefined, 'afterhours_chat=guessed')).status, 401);
    const one = await open(), two = await open(); assert.notEqual(one, two);
    assert.equal((await request('/api/chat', {message:'hello', profile:'default'}, one)).status, 400);
    assert.equal((await request('/api/chat', {message:'hello', messages:[]}, one)).status, 400);
    assert.equal((await request('/api/chat', {message:'hello'}, one, 'https://evil.example')).status, 403);
    assert.equal((await request('/api/chat', {message:'hello'}, one)).status, 200);
    assert.equal(replies, 1);
    assert.equal((await (await request('/api/chat', undefined, one)).json()).messages.length, 2);
    assert.equal((await (await request('/api/chat', undefined, two)).json()).messages.length, 0);
    const restored = await request('/api/chat/session', {}, one);
    assert.equal(restored.headers.get('set-cookie'), null);
    assert.equal((await restored.json()).messages.length, 2);
    assert.equal((await request('/api/chat/reset', {}, one)).status, 200);
    assert.equal((await (await request('/api/chat', undefined, one)).json()).messages.length, 0);
    assert.equal((await request('/api/chat', {message:'new conversation'}, one)).status, 200);
    assert.notEqual(conversations[0], conversations[1]);
    for (let i=0; i<6; i++) assert.equal((await request('/api/chat', {message:'again'}, one)).status, 200);
    assert.equal((await request('/api/chat', {message:'too many'}, one)).status, 429);
    // Rotating anonymous cookies does not evade the IP completion cap.
    for (let i=0; i<8; i++) assert.equal((await request('/api/chat', {message:'another browser'}, two)).status, 200);
    const three = await open();
    for (let i=0; i<3; i++) assert.equal((await request('/api/chat', {message:'last few'}, three)).status, 200);
    assert.equal((await request('/api/chat', {message:'over IP limit'}, three)).status, 429);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('unconfigured public chat admits visitors but never invents a reply', async () => {
  const server = createWebServer({read: async () => sampleMarketState()}, 'sample', { origin, runtime: createHermesRuntime(), evidence: async () => 'sample' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const opened = await fetch(`${base}/api/chat/session`, {method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
    assert.equal(opened.status, 200); assert.equal((await opened.json()).agentConfigured, false);
    const res = await fetch(`${base}/api/chat`, { method:'POST',headers:{origin,'content-type':'application/json',cookie:opened.headers.getSetCookie()[0].split(';')[0]},body:JSON.stringify({message:'hello'}) });
    assert.equal(res.status, 503); assert.match((await res.json()).error, /not connected/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
