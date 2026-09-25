import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveDexProfile } from '../src/dex-profile.js';
import { SocialPublisher } from '../src/social.js';

const token = '0x6918EcC39996DAE959FBb7aAb1F6e926f285eBd4';
const pairUrl = 'https://dexscreener.com/robinhood/0x5054ee8f684356b9e050d6322625c5480d43d64abbb4126c3857e8453786d6a8';
const approvedOrder = { orders: [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 1789900000 }] };
const publishedPair = [{ chainId: 'robinhood', baseToken: { address: token }, url: pairUrl,
  liquidity: { usd: 1000 }, info: { imageUrl: 'https://example.com/icon.png',
    websites: [{ url: 'https://agent-production-02cc.up.railway.app/' }],
    socials: [{ type: 'twitter', url: 'https://x.com/AHagentRh' }] } }];

test('DEX Screener review requires both a paid approved order and the public profile', async () => {
  let orders = { orders: [] };
  let pairs = publishedPair;
  const request = async url => ({ status: 200, json: async () => url.includes('/orders/') ? orders : pairs });
  const check = () => liveDexProfile({ token, handle: 'AHagentRh', request });
  assert.equal(await check(), null);
  orders = { orders: [{ type: 'tokenProfile', status: 'processing', paymentTimestamp: 1789900000 }] };
  assert.equal(await check(), null);
  orders = approvedOrder;
  pairs = [{ ...publishedPair[0], info: { ...publishedPair[0].info, socials: [] } }];
  assert.equal(await check(), null);
  pairs = publishedPair;
  assert.equal(await check(), pairUrl);
});

test('a marketplace-finalized order ID can confirm payment when the public orders API lags', async () => {
  const paths = [];
  const request = async url => {
    paths.push(url);
    return { status: 200, json: async () => publishedPair };
  };
  assert.equal(await liveDexProfile({ token, handle: 'AHagentRh',
    approvedOrderId: '1789904955599', request }), pairUrl);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /token-pairs/);
});

test('agent announces the live profile once and never pays DEX Screener', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dex-profile-'));
  try {
    let orders = { orders: [] };
    let pairs = publishedPair;
    const posts = [];
    const calls = [];
    const env = {
      X_POSTING_ENABLED: 'true', X_BUYS_PER_POST: '0',
      X_AUTOMATED_LABEL_CONFIRMED: 'true', X_ACCOUNT_HANDLE: 'AHagentRh',
      X_API_KEY: 'test', X_API_SECRET: 'test', X_ACCESS_TOKEN: 'test', X_ACCESS_TOKEN_SECRET: 'test',
      DEXSCREENER_PROFILE_WATCH_ENABLED: 'true', PONS_TOKEN_ADDRESS: token,
    };
    const setup = { env, statePath: join(directory, 'x-posting.json'),
      now: () => new Date('2026-09-20T12:00:00.000Z'), events: () => [],
      status: () => ({ board: null }), record: () => {},
      request: async (url, options) => {
        calls.push([url, options.method]);
        if (url.includes('/orders/')) return { status: 200, json: async () => orders };
        if (url.includes('/token-pairs/')) return { status: 200, json: async () => pairs };
        if (url.endsWith('/users/me')) return { status: 200,
          json: async () => ({ data: { username: 'AHagentRh' } }) };
        assert.equal(url, 'https://api.x.com/2/tweets');
        posts.push(JSON.parse(options.body).text);
        return { status: 201, json: async () => ({ data: { id: '12345' } }) };
      },
    };
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 0);
    orders = approvedOrder;
    pairs = [{ ...publishedPair[0], info: { ...publishedPair[0].info, websites: [] } }];
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 0);
    pairs = publishedPair;
    await new SocialPublisher(setup).flush();
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 1);
    assert.match(posts[0], /Enhanced Token Info is live/);
    assert.match(posts[0], /dexscreener\.com\/robinhood/);
    assert.equal(calls.filter(([url]) => url.startsWith('https://api.dexscreener.com'))
      .every(([, method]) => method === 'GET'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
