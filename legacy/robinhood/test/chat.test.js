import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebChat } from '../src/chat.js';

const snapshot = () => ({
  network: 'Robinhood Chain', chainId: 4663, status: 'healthy', mode: 'read-only',
  lastSucceededAt: '2026-09-21T20:00:00.000Z', creatorWallet: null, ponsToken: null,
  board: { checkedAt: '2026-09-21T20:00:00.000Z', quoteSizeUsdg: '5',
    rows: [{ ticker: 'AAPL', onchain: 95, close: 100, discount: 5 }] },
  portfolio: { checkedAt: '2026-09-21T20:00:00.000Z', cashUsdg: '50',
    treasuryValuationComplete: true, estimatedTreasuryUsdg: '55',
    stocks: [{ ticker: 'AAPL', quantity: '0', estimatedSellUsdg: '0' }],
    afterhours: { quantity: '100', estimatedSellUsdg: '5' } },
  totals: { claimedUsdg: '12' }, policy: { exitEnabled: false, buybackEnabled: false },
});

async function serve(chat) {
  const server = createServer((req, res) => { void chat(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

const post = (url, message, extra = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...extra.headers },
  body: JSON.stringify({ message, history: extra.history || [] }),
});

test('public chat requires AI and rejects bad or excessive requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterhours-chat-'));
  const chat = createWebChat({ env: {}, status: snapshot, now: () => new Date('2026-09-21T20:01:00.000Z'),
    budgetPath: join(dir, 'budget.json') });
  const { server, url } = await serve(chat);
  try {
    const response = await post(url, 'What is the AAPL price?');
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /not configured/);
    assert.equal((await post(url, ' ', {})).status, 400);
    assert.equal((await post(url, 'hello', { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
    for (let i = 0; i < 5; i++) assert.equal((await post(url, 'hello')).status, 503);
    assert.equal((await post(url, 'hello')).status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI chat receives only public facts and respects a persistent daily spend cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterhours-chat-ai-'));
  const budgetPath = join(dir, 'budget.json');
  let calls = 0;
  let supplied;
  const chat = createWebChat({
    env: { WEB_CHAT_ENABLED: 'true', OPENAI_API_KEY: 'test-key' },
    status: snapshot, budgetPath, now: () => new Date('2026-09-21T20:01:00.000Z'),
    request: async (_url, options) => {
      calls++;
      supplied = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'completed', output: [
        { content: [{ type: 'output_text', text: 'The latest public board shows an AAPL pool quote of 95 USDG.' }] },
      ] }) };
    },
  });
  const { server, url } = await serve(chat);
  try {
    const response = await post(url, 'And AAPL?', { history: [
      { role: 'user', content: 'What is the latest quote?' },
      { role: 'assistant', content: 'The public board has an AAPL quote.' },
    ] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mode, 'ai');
    assert.equal(calls, 1);
    assert.equal(supplied.store, false);
    assert.equal(supplied.max_output_tokens, 300);
    assert.match(supplied.input, /"ticker":"AAPL"/);
    assert.match(supplied.input, /"afterhours":\{"quantity":"100"/);
    assert.doesNotMatch(supplied.input, /private.key|AGENT_PRIVATE_KEY/i);
    assert.equal(JSON.parse(readFileSync(budgetPath, 'utf8')).count, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  writeFileSync(budgetPath, JSON.stringify({ version: 1, date: '2026-09-21', count: 499 }));
  let finalCallCount = 0;
  const capped = createWebChat({ env: { WEB_CHAT_ENABLED: 'true', OPENAI_API_KEY: 'test-key' },
    status: snapshot, budgetPath, now: () => new Date('2026-09-21T20:02:00.000Z'),
    request: async () => {
      finalCallCount++;
      return { ok: true, json: async () => ({ status: 'completed', output: [
        { content: [{ type: 'output_text', text: 'The treasury has public USDG and token balances.' }] },
      ] }) };
    } });
  const next = await serve(capped);
  try {
    assert.equal((await post(next.url, 'How is the agent?')).status, 200);
    assert.equal(JSON.parse(readFileSync(budgetPath, 'utf8')).count, 500);
    const response = await post(next.url, 'And now?');
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /chat limit/);
    assert.equal(finalCallCount, 1);
  } finally {
    await new Promise(resolve => next.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI corrects a holdings answer that calls Stock Tokens shares or omits balances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterhours-chat-correction-'));
  const budgetPath = join(dir, 'budget.json');
  let calls = 0;
  const chat = createWebChat({
    env: { WEB_CHAT_ENABLED: 'true', OPENAI_API_KEY: 'test-key' },
    status: snapshot, budgetPath,
    request: async (_url, options) => {
      calls++;
      const instructions = JSON.parse(options.body).instructions;
      if (calls === 2) assert.match(instructions, /Correct these issues/);
      const answer = calls === 1
        ? 'I hold 0 AAPL shares.'
        : '**At the last portfolio check**, I hold 50 USDG, 0 AAPL Stock Tokens, and 100 $AFTERHOURS tokens.';
      return { ok: true, json: async () => ({ status: 'completed', output: [
        { content: [{ type: 'output_text', text: answer }] },
      ] }) };
    },
  });
  const { server, url } = await serve(chat);
  try {
    const response = await post(url, 'What does the agent hold right now?');
    assert.equal(response.status, 200);
    const answer = (await response.json()).answer;
    assert.match(answer, /100 \$AFTERHOURS tokens/);
    assert.doesNotMatch(answer, /\*\*/);
    assert.equal(calls, 2);
    assert.equal(JSON.parse(readFileSync(budgetPath, 'utf8')).count, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI failure is reported instead of substituting a canned answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterhours-chat-failure-'));
  const chat = createWebChat({
    env: { WEB_CHAT_ENABLED: 'true', OPENAI_API_KEY: 'test-key' },
    status: snapshot, budgetPath: join(dir, 'budget.json'),
    request: async () => ({ ok: false, status: 503 }),
  });
  const { server, url } = await serve(chat);
  try {
    const response = await post(url, 'How did the last trade work?');
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /AI agent is unavailable/);
    assert.equal(body.answer, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
