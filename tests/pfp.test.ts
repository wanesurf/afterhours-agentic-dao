import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { normalizeXHandle } from '../apps/web/src/pfp-routes.js';
import { createWebServer, sampleMarketState } from '../apps/web/src/server.js';
const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 1, 2, 3]);
async function withServer(fetchImpl: typeof fetch, fn: (base: string) => Promise<void>) {
  const server = createWebServer({ read: async () => sampleMarketState() }, 'sample', undefined, { fetchImpl, apiKey: '' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await fn(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test('X handle normalization accepts profiles and rejects URL injection', () => {
  for (const input of ['@Helwan_Mande', 'helwan_mande', 'https://x.com/helwan_mande', 'https://twitter.com/helwan_mande/?s=20']) assert.equal(normalizeXHandle(input), 'helwan_mande');
  for (const input of ['', 'https://evil.test/x', 'https://x.com.evil.test/a', 'https://user@x.com/a', 'https://x.com:8080/a', 'https://x.com/a/status/123', '../../secret', '@two handles', '1234567890123456']) assert.throws(() => normalizeXHandle(input), input);
});
test('PFP routes serve the editor and reject untrusted lookup URLs before fetching', async () => {
  let calls = 0;
  await withServer(async () => { calls++; return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }); }, async base => {
    for (const path of ['/pfp', '/pfp/', '/pfp.css', '/pfp.js']) {
      const res = await fetch(base + path); assert.equal(res.status, 200);
      assert.match(res.headers.get('content-security-policy') || '', /img-src 'self' data: blob:/);
    }
    assert.equal((await fetch(base + '/api/pfp/avatar?handle=https://127.0.0.1/private')).status, 400);
    assert.equal((await fetch(base + '/api/pfp/avatar?handle=test', { method: 'POST' })).status, 405);
    assert.equal(calls, 0);
  });
});
test('avatar proxy uses only Unavatar, rejects redirects, and coalesces cached lookups', async () => {
  let calls = 0;
  await withServer(async (url, options) => {
    calls++; assert.equal(String(url), 'https://unavatar.io/x/helwan_mande?fallback=false'); assert.equal(options?.redirect, 'error');
    await new Promise(r => setTimeout(r, 15)); return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
  }, async base => {
    const responses = await Promise.all([fetch(base + '/api/pfp/avatar?handle=helwan_mande'), fetch(base + '/api/pfp/avatar?handle=@Helwan_Mande')]);
    for (const res of responses) { assert.equal(res.status, 200); assert.equal(res.headers.get('x-avatar-handle'), 'helwan_mande'); assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg); }
    assert.equal((await fetch(base + '/api/pfp/avatar?handle=helwan_mande')).status, 200); assert.equal(calls, 1);
  });
});
for (const [name, response, status] of [
  ['not found', () => new Response('', { status: 404 }), 404],
  ['rate limit', () => new Response('', { status: 429 }), 429],
  ['HTML', () => new Response('<html>', { headers: { 'content-type': 'text/html' } }), 502],
  ['SVG', () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }), 502],
  ['fake JPEG', () => new Response('not a photo', { headers: { 'content-type': 'image/jpeg' } }), 502],
  ['oversized stream', () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } }), 502],
] as const) test(`avatar proxy returns an actionable error for ${name}`, async () => {
  await withServer(async () => response(), async base => {
    const res = await fetch(base + '/api/pfp/avatar?handle=someone'); assert.equal(res.status, status);
    assert.match((await res.json()).error, /upload/i); assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});
test('avatar lookup bounds anonymous upstream traffic', async () => {
  let calls = 0;
  await withServer(async () => { calls++; return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }); }, async base => {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(base + `/api/pfp/avatar?handle=person${i}`)).status, 200);
    assert.equal((await fetch(base + '/api/pfp/avatar?handle=another')).status, 429); assert.equal(calls, 10);
    assert.equal((await fetch(base + '/api/pfp/avatar?handle=person0')).status, 200);
  });
});
