import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buybackPost, exitPost, oauthSignature, SocialPublisher, transactionPost } from '../src/social.js';

const enabled = {
  X_POSTING_ENABLED: 'true',
  X_BUYS_PER_POST: '0',
  X_AUTOMATED_LABEL_CONFIRMED: 'true',
  X_ACCOUNT_HANDLE: 'ScoutBot',
  X_API_KEY: 'app-key',
  X_API_SECRET: 'app-secret',
  X_ACCESS_TOKEN: 'user-token',
  X_ACCESS_TOKEN_SECRET: 'user-secret',
};
const at = new Date('2026-09-21T21:30:00.000Z');
const tx = digit => '0x' + digit.repeat(64);
const wallet = '0x1111111111111111111111111111111111111111';
const portfolio = {
  wallet, checkedAt: new Date(at.getTime() + 1000).toISOString(), cashUsdg: '84.637739',
  stocks: [
    { ticker: 'NVDA', quantity: '0.022627191892361135' },
    { ticker: 'AAPL', quantity: '0.029925424334264034' },
  ],
};
const filledSale = {
  ticker: 'NVDA', quantity: '6.860059', acquisitionCostUsdg: '1500.00',
  proceedsUsdg: '1540.25', grossSpreadUsdg: '40.25',
  filledAt: at.toISOString(), txHash: tx('f'),
};
const completedBurn = {
  at: at.toISOString(), spentUsdg: '10', burned: '343281.998832555667213075',
  swapTxHash: tx('a'), burnTxHash: tx('b'),
};

test('confirmed buyback and burn post once with both receipt hashes, never before completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const posts = [];
    let burns = [];
    const setup = { env: { ...enabled, X_BUYS_PER_POST: '10' }, now: () => at,
      statePath: join(directory, 'x-posting.json'), events: () => [],
      exits: () => ({ sales: [] }), buybacks: () => ({ burns }),
      status: () => ({ totals: { buys: 50 } }), record: () => {},
      request: async (url, options) => url.endsWith('/users/me')
        ? { status: 200, json: async () => ({ data: { username: 'ScoutBot' } }) }
        : (posts.push(JSON.parse(options.body).text),
          { status: 201, json: async () => ({ data: { id: String(posts.length) } }) }),
    };
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 0);
    burns = [completedBurn];
    await new SocialPublisher(setup).flush();
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 1);
    assert.match(posts[0], /10\.00 USDG gross spread \(before Oracle\/gas\)/);
    assert.match(posts[0], /burned ~343,281 \$AFTERHOURS/);
    assert.match(posts[0], new RegExp(tx('a')));
    assert.match(posts[0], new RegExp(tx('b')));
    assert.ok([...posts[0]].length <= 280);
    assert.equal(JSON.parse(readFileSync(setup.statePath, 'utf8'))
      .attempts['buyback_burn:' + tx('b')].status, 'posted');
    assert.equal(buybackPost({ ...completedBurn, burned: '0' }), null);
    assert.equal(buybackPost({ ...completedBurn, burnTxHash: 'invalid' }), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('confirmed UniswapX sales post once with actual proceeds and gross profit in ten-buy mode', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const posts = [];
    const recorded = [];
    let sales = [];
    const setup = { env: { ...enabled, X_BUYS_PER_POST: '10' }, now: () => at,
      statePath: join(directory, 'x-posting.json'), events: () => [],
      exits: () => ({ sales }), status: () => ({ totals: { buys: 50 } }),
      record: (...entry) => recorded.push(entry),
      request: async (url, options) => url.endsWith('/users/me')
        ? { status: 200, json: async () => ({ data: { username: 'ScoutBot' } }) }
        : (posts.push(JSON.parse(options.body).text),
          { status: 201, json: async () => ({ data: { id: String(posts.length) } }) }),
    };
    const publisher = new SocialPublisher(setup);
    await publisher.flush();
    assert.equal(posts.length, 0);
    sales = [filledSale];
    await publisher.flush();
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 1);
    assert.match(posts[0], /I sold NVDA Stock Tokens via UniswapX for 1540\.25 USDG/);
    assert.match(posts[0], /Acquisition cost: 1500\.00 USDG\. Gross trading profit: \+40\.25 USDG/);
    assert.match(posts[0], /before Oracle and gas/);
    assert.match(posts[0], new RegExp(tx('f')));
    assert.ok([...posts[0]].length <= 280);
    assert.equal(recorded.filter(entry => entry[0] === 'x_post_published').length, 1);
    assert.equal(JSON.parse(readFileSync(setup.statePath, 'utf8')).attempts['exit_filled:' + tx('f')].status, 'posted');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sale post refuses inconsistent profit and reports a loss honestly', () => {
  assert.equal(exitPost({ ...filledSale, grossSpreadUsdg: '4000' }), null);
  assert.match(exitPost({ ...filledSale, proceedsUsdg: '1490', grossSpreadUsdg: '-10' }),
    /Gross trading loss: -10\.00 USDG/);
});

test('a definite X daily-limit rejection retries the sale once the next ET day', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    let current = at;
    let requests = 0;
    const setup = { env: { ...enabled, X_BUYS_PER_POST: '10', X_MAX_POSTS_PER_DAY: '0' },
      now: () => current, statePath: join(directory, 'x-posting.json'), events: () => [],
      exits: () => ({ sales: [filledSale] }), status: () => ({ totals: { buys: 50 } }), record: () => {},
      request: async url => url.endsWith('/users/me')
        ? { status: 200, json: async () => ({ data: { username: 'ScoutBot' } }) }
        : (++requests === 1
          ? { status: 403, text: async () => '{"code":185,"detail":"daily post limit"}' }
          : { status: 201, json: async () => ({ data: { id: '999' } }) }),
    };
    const publisher = new SocialPublisher(setup);
    await publisher.flush();
    await publisher.flush();
    assert.equal(requests, 1);
    current = new Date(at.getTime() + 24 * 60 * 60_000);
    await new SocialPublisher(setup).flush();
    await new SocialPublisher(setup).flush();
    assert.equal(requests, 2);
    const attempts = JSON.parse(readFileSync(setup.statePath, 'utf8')).attempts;
    assert.equal(attempts['exit_filled:' + tx('f')].status, 'rejected');
    assert.equal(Object.values(attempts).filter(value => value.status === 'posted').length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OAuth signature matches the X documentation example', () => {
  assert.equal(oauthSignature({
    method: 'POST', url: 'https://api.x.com/1.1/statuses/update.json',
    params: {
      status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      include_entities: 'true',
      oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
      oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1318622958',
      oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      oauth_version: '1.0',
    },
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  }), 'Ls93hJiZbQ3akF3HF3x1Bz8/zU4=');
});

test('X posting stays off without opt-in and fails closed on incomplete setup', async () => {
  let requests = 0;
  const publisher = new SocialPublisher({ env: {}, request: async () => { requests++; } });
  await publisher.flush({ cycleSuccess: true });
  assert.equal(requests, 0);
  assert.throws(() => new SocialPublisher({ env: { ...enabled, X_AUTOMATED_LABEL_CONFIRMED: 'false' } }),
    /automated label/);
  assert.throws(() => new SocialPublisher({ env: { ...enabled, X_ACCESS_TOKEN: '' } }),
    /credentials/);
});

test('confirmed payments and buys publish once, with verified facts and persistent deduplication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const statePath = join(directory, 'x-posting.json');
    const events = [
      { id: 1, at: at.toISOString(), type: 'api_paid', ticker: 'AAPL', amountUsdg: '0.05', txHash: tx('a') },
      { id: 2, at: at.toISOString(), type: 'buy_confirmed', ticker: 'NVDA', amountUsdg: '5', txHash: tx('b') },
    ];
    const posts = [];
    const recorded = [];
    const request = async (url, options) => {
      if (url === 'https://api.x.com/2/users/me') {
        assert.equal(options.method, 'GET');
        return { status: 200, json: async () => ({ data: { username: 'ScoutBot' } }) };
      }
      assert.equal(url, 'https://api.x.com/2/tweets');
      assert.match(options.headers.Authorization, /^OAuth /);
      posts.push(JSON.parse(options.body).text);
      return { status: 201, json: async () => ({ data: { id: String(100 + posts.length) } }) };
    };
    const setup = { env: enabled, request, now: () => at, statePath, events: () => events,
      status: () => ({ board: null, creatorWallet: wallet, portfolio }), record: (...entry) => recorded.push(entry) };
    await new SocialPublisher(setup).flush();
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 2);
    assert.match(posts[0], /Bought NVDA Stock Tokens for 5\.00 USDG/);
    assert.match(posts[0], /Holdings: NVDA 0\.02262719, AAPL 0\.02992542; USDG 84\.637739\./);
    assert.match(posts[0], new RegExp(tx('b')));
    assert.match(posts[0], /Stock Tokens are tokenized exposure, not shares\./);
    assert.match(posts[0], /https:\/\/agent-production-02cc\.up\.railway\.app\//);
    assert.ok([...posts[0]].length <= 280);
    assert.match(posts[1], /AAPL Oracle quote paid: 0\.05 USDG/);
    assert.match(posts[1], /A paid quote is not a stock purchase/);
    assert.equal(recorded.filter(entry => entry[0] === 'x_post_published').length, 2);
    assert.equal(Object.values(JSON.parse(readFileSync(statePath, 'utf8')).attempts).every(x => x.status === 'posted'), true);
    assert.equal(transactionPost({ type: 'buy_confirmed', ticker: 'FAKE', amountUsdg: '5', txHash: tx('a') }), null);
    assert.equal(transactionPost(events[1], { ...portfolio, checkedAt: at.toISOString().replace('30:00', '29:59') }, wallet), null);
    assert.equal(transactionPost(events[1], portfolio, '0x2222222222222222222222222222222222222222'), null);
    assert.equal(transactionPost(events[1], null, wallet), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OpenAI varies only the opening while confirmed transaction facts remain fixed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const events = [
      { id: 1, at: at.toISOString(), type: 'api_paid', ticker: 'AAPL', amountUsdg: '0.05', txHash: tx('a') },
      { id: 2, at: at.toISOString(), type: 'buy_confirmed', ticker: 'NVDA', amountUsdg: '5', txHash: tx('b') },
    ];
    const posts = [];
    const aiCalls = [];
    const setup = { env: { ...enabled, OPENAI_API_KEY: 'test-key' }, now: () => at,
      statePath: join(directory, 'x-posting.json'), events: () => events,
      status: () => ({ board: null, creatorWallet: wallet, portfolio }), record: () => {},
      request: async (url, options) => {
        if (url.endsWith('/users/me')) return { status: 200,
          json: async () => ({ data: { username: 'ScoutBot' } }) };
        if (url.includes('openai.com')) {
          const prompt = JSON.parse(options.body);
          aiCalls.push(prompt);
          const text = JSON.parse(prompt.input).type === 'buy_confirmed'
            ? 'Added NVDA Stock Tokens for 5.00 USDG.'
            : 'Paid 0.05 USDG for the AAPL Oracle quote.';
          return { ok: true, json: async () => ({ status: 'completed',
            output: [{ content: [{ type: 'output_text', text }] }] }) };
        }
        posts.push(JSON.parse(options.body).text);
        return { status: 201, json: async () => ({ data: { id: String(posts.length) } }) };
      },
    };
    await new SocialPublisher(setup).flush();
    await new SocialPublisher(setup).flush();
    assert.equal(aiCalls.length, 2);
    assert.equal(aiCalls.every(call => call.store === false), true);
    assert.equal(posts.length, 2);
    assert.match(posts[0], /^Added NVDA Stock Tokens for 5\.00 USDG\./);
    assert.match(posts[0], /Holdings: NVDA 0\.02262719, AAPL 0\.02992542; USDG 84\.637739\./);
    assert.match(posts[0], new RegExp(tx('b')));
    assert.match(posts[0], /Stock Tokens are tokenized exposure, not shares\./);
    assert.match(posts[0], /https:\/\/agent-production-02cc\.up\.railway\.app\//);
    assert.match(posts[1], /^Paid 0\.05 USDG for the AAPL Oracle quote\./);
    assert.match(posts[1], new RegExp(tx('a')));
    assert.match(posts[1], /A paid quote is not a stock purchase\./);
    assert.equal(posts.every(post => [...post].length <= 280), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unsupported AI claim falls back to the factual receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const event = { id: 1, at: at.toISOString(), type: 'buy_confirmed',
      ticker: 'NVDA', amountUsdg: '5', txHash: tx('c') };
    const posts = [];
    const recorded = [];
    const publisher = new SocialPublisher({ env: { ...enabled, OPENAI_API_KEY: 'test-key' },
      now: () => at, statePath: join(directory, 'x-posting.json'), events: () => [event],
      status: () => ({ board: null, creatorWallet: wallet, portfolio }),
      record: (...entry) => recorded.push(entry),
      request: async (url, options) => {
        if (url.endsWith('/users/me')) return { status: 200,
          json: async () => ({ data: { username: 'ScoutBot' } }) };
        if (url.includes('openai.com')) return { ok: true, json: async () => ({ status: 'completed',
          output: [{ content: [{ type: 'output_text',
            text: 'NVDA guarantees profit after a 5.00 USDG Stock Tokens buy.' }] }] }) };
        posts.push(JSON.parse(options.body).text);
        return { status: 201, json: async () => ({ data: { id: '123' } }) };
      },
    });
    await publisher.flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0], transactionPost(event, portfolio, wallet));
    assert.equal(recorded.filter(entry => entry[0] === 'x_draft_fallback').length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('buy updates take priority over payment posts when daily X capacity is scarce', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const posts = [];
    const events = [
      { id: 1, at: at.toISOString(), type: 'api_paid', ticker: 'AAPL', amountUsdg: '0.05', txHash: tx('a') },
      { id: 2, at: at.toISOString(), type: 'buy_confirmed', ticker: 'AAPL', amountUsdg: '5', txHash: tx('b') },
    ];
    const publisher = new SocialPublisher({ env: { ...enabled, X_MAX_POSTS_PER_DAY: '1' },
      now: () => at, statePath: join(directory, 'x-posting.json'), events: () => events,
      status: () => ({ board: null, creatorWallet: wallet, portfolio }), record: () => {},
      request: async (url, options) => url.endsWith('/users/me')
        ? { status: 200, json: async () => ({ data: { username: 'ScoutBot' } }) }
        : (posts.push(JSON.parse(options.body).text),
          { status: 201, json: async () => ({ data: { id: '123' } }) }),
    });
    await publisher.flush();
    assert.equal(posts.length, 1);
    assert.match(posts[0], /Bought AAPL/);
    assert.match(posts[0], /Holdings:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('zero daily X cap publishes new events beyond twenty without replaying older events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const old = { id: 1, at: '2026-09-21T21:20:00.000Z', type: 'api_paid',
      ticker: 'AAPL', amountUsdg: '0.05', txHash: tx('a') };
    const events = [old, ...Array.from({ length: 21 }, (_, index) => ({
      id: index + 2, at: at.toISOString(), type: 'buy_confirmed',
      ticker: 'NVDA', amountUsdg: '5', txHash: '0x' + (index + 1).toString(16).padStart(64, '0'),
    }))];
    const posts = [];
    const setup = { env: { ...enabled, X_MAX_POSTS_PER_DAY: '0',
      X_POST_EVENTS_AFTER: '2026-09-21T21:29:00.000Z' },
    now: () => at, statePath: join(directory, 'x-posting.json'), events: () => events,
    status: () => ({ board: null, creatorWallet: wallet, portfolio }), record: () => {},
    request: async (url, options) => url.endsWith('/users/me')
      ? { status: 200, json: async () => ({ data: { username: 'ScoutBot' } }) }
      : (posts.push(JSON.parse(options.body).text),
        { status: 201, json: async () => ({ data: { id: String(posts.length) } }) }),
    };
    await new SocialPublisher(setup).flush();
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 21);
    assert.equal(posts.every(post => post.startsWith('Bought NVDA')), true);
    assert.equal(Object.keys(JSON.parse(readFileSync(setup.statePath, 'utf8')).attempts).length, 21);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('uncertain X response is never automatically repeated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const event = { id: 1, at: at.toISOString(), type: 'api_paid', ticker: 'AAPL', amountUsdg: '0.05', txHash: tx('c') };
    let requests = 0;
    const setup = { env: enabled, request: async url => {
      if (url === 'https://api.x.com/2/users/me') return { status: 200,
        json: async () => ({ data: { username: 'ScoutBot' } }) };
      requests++; return { status: 503 };
    },
      now: () => at, statePath: join(directory, 'x-posting.json'), events: () => [event],
      status: () => ({ board: null }), record: () => {} };
    await new SocialPublisher(setup).flush();
    await new SocialPublisher(setup).flush();
    assert.equal(requests, 1);
    assert.equal(Object.values(JSON.parse(readFileSync(setup.statePath, 'utf8')).attempts)[0].status, 'uncertain');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('X 403 rejects an event without pausing later new events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const events = [
      { id: 1, at: at.toISOString(), type: 'api_paid', ticker: 'AAPL', amountUsdg: '0.05', txHash: tx('a') },
      { id: 2, at: at.toISOString(), type: 'buy_confirmed', ticker: 'NVDA', amountUsdg: '5', txHash: tx('b') },
    ];
    const recorded = [];
    let posts = 0;
    let current = at;
    let reject = true;
    const statePath = join(directory, 'x-posting.json');
    const setup = { env: enabled, now: () => current, statePath, events: () => events,
      status: () => ({ board: null, creatorWallet: wallet,
        portfolio: { ...portfolio, checkedAt: new Date(current.getTime() + 1000).toISOString() } }),
      record: (...entry) => recorded.push(entry),
      request: async url => {
        if (url.endsWith('/users/me')) return { status: 200,
          json: async () => ({ data: { username: 'ScoutBot' } }) };
        posts++;
        return reject ? { status: 403, text: async () =>
          '{"title":"Forbidden","detail":"User is over daily status update limit.","code":185}' } :
          { status: 201, json: async () => ({ data: { id: '123456789' } }) };
      },
    };
    await new SocialPublisher(setup).flush();
    await new SocialPublisher(setup).flush();
    assert.equal(posts, 2);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.attempts['buy_confirmed:' + tx('b')].status, 'rejected');
    assert.equal(state.attempts['buy_confirmed:' + tx('b')].httpStatus, 403);
    assert.equal(JSON.parse(state.attempts['buy_confirmed:' + tx('b')].responseBody).code, 185);
    assert.equal(state.attempts['api_paid:' + tx('a')].status, 'rejected');
    assert.equal(state.postingBlockedUntil, undefined);
    assert.equal(recorded.filter(entry => entry[0] === 'x_post_rejected').length, 2);
    assert.equal(recorded.filter(entry => entry[0] === 'x_post_paused').length, 0);
    assert.equal(recorded.filter(entry => entry[0] === 'x_post_uncertain').length, 0);
    reject = false;
    current = new Date(at.getTime() + 60_000);
    events.push({ id: 3, at: current.toISOString(), type: 'buy_confirmed',
      ticker: 'NVDA', amountUsdg: '5', txHash: tx('c') });
    await new SocialPublisher(setup).flush();
    assert.equal(posts, 3);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).attempts['buy_confirmed:' + tx('c')].status, 'posted');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('milestone mode posts the tenth confirmed buy with current holdings and persists its count', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const statePath = join(directory, 'x-posting.json');
    let totalBuys = 50;
    const events = [{ id: 1, at: at.toISOString(), type: 'api_paid',
      ticker: 'AAPL', amountUsdg: '0.05', txHash: tx('a') }];
    const posts = [];
    const setup = { env: { ...enabled, X_BUYS_PER_POST: '10', X_MAX_POSTS_PER_DAY: '0' },
      now: () => at, statePath, events: () => events,
      status: () => ({ totals: { buys: totalBuys }, board: null, creatorWallet: wallet, portfolio }),
      record: () => {},
      request: async (url, options) => url.endsWith('/users/me')
        ? { status: 200, json: async () => ({ data: { username: 'ScoutBot' } }) }
        : (posts.push(JSON.parse(options.body).text),
          { status: 201, json: async () => ({ data: { id: String(posts.length) } }) }),
    };
    const publisher = new SocialPublisher(setup);
    await publisher.flush({ cycleSuccess: true });
    assert.equal(posts.length, 0);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).buyPostCursor, 50);
    for (let index = 1; index <= 9; index++) {
      totalBuys++;
      events.push({ id: index + 1, at: at.toISOString(), type: 'buy_confirmed',
        ticker: 'NVDA', amountUsdg: '5', txHash: '0x' + index.toString(16).padStart(64, '0') });
      await publisher.flush({ cycleSuccess: true });
    }
    assert.equal(posts.length, 0);
    totalBuys++;
    events.push({ id: 11, at: at.toISOString(), type: 'buy_confirmed',
      ticker: 'NVDA', amountUsdg: '5', txHash: tx('b') });
    await publisher.flush({ cycleSuccess: true });
    assert.equal(posts.length, 1);
    assert.match(posts[0], new RegExp(tx('b')));
    assert.match(posts[0], /Holdings: NVDA/);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).buyPostCursor, 60);
    const restarted = new SocialPublisher(setup);
    await restarted.flush({ cycleSuccess: true });
    assert.equal(posts.length, 1);
    for (let index = 11; index <= 20; index++) {
      totalBuys++;
      events.push({ id: index + 1, at: at.toISOString(), type: 'buy_confirmed',
        ticker: 'AAPL', amountUsdg: '5', txHash: '0x' + index.toString(16).padStart(64, '0') });
      await restarted.flush({ cycleSuccess: true });
    }
    assert.equal(posts.length, 2);
    assert.match(posts[1], /Bought AAPL/);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).buyPostCursor, 70);
    assert.equal(Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).attempts).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a rejected milestone consumes only that ten-buy window', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    let totalBuys = 0;
    let rejected = true;
    let requests = 0;
    const events = [];
    const statePath = join(directory, 'x-posting.json');
    const setup = { env: { ...enabled, X_BUYS_PER_POST: '10', X_MAX_POSTS_PER_DAY: '0' },
      now: () => at, statePath, events: () => events,
      status: () => ({ totals: { buys: totalBuys }, creatorWallet: wallet, portfolio }), record: () => {},
      request: async url => {
        if (url.endsWith('/users/me')) return { status: 200,
          json: async () => ({ data: { username: 'ScoutBot' } }) };
        requests++;
        return rejected ? { status: 403 } :
          { status: 201, json: async () => ({ data: { id: String(requests) } }) };
      },
    };
    const publisher = new SocialPublisher(setup);
    for (let index = 1; index <= 10; index++) {
      totalBuys++;
      events.push({ id: index, at: at.toISOString(), type: 'buy_confirmed',
        ticker: 'NVDA', amountUsdg: '5', txHash: '0x' + index.toString(16).padStart(64, '0') });
    }
    await publisher.flush();
    assert.equal(requests, 1);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).buyPostCursor, 10);
    rejected = false;
    for (let index = 11; index <= 19; index++) {
      totalBuys++;
      events.push({ id: index, at: at.toISOString(), type: 'buy_confirmed',
        ticker: 'NVDA', amountUsdg: '5', txHash: '0x' + index.toString(16).padStart(64, '0') });
      await new SocialPublisher(setup).flush();
    }
    assert.equal(requests, 1);
    totalBuys++;
    events.push({ id: 20, at: at.toISOString(), type: 'buy_confirmed',
      ticker: 'NVDA', amountUsdg: '5', txHash: tx('c') });
    await new SocialPublisher(setup).flush();
    assert.equal(requests, 2);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.buyPostCursor, 20);
    assert.equal(state.attempts['buy_confirmed:' + tx('c')].status, 'posted');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deployment clears a legacy pause without replaying events before an earlier resume cutoff', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const statePath = join(directory, 'x-posting.json');
    writeFileSync(statePath, JSON.stringify({ version: 1, attempts: {}, marketDates: [],
      postingBlockedUntil: new Date(at.getTime() + 6 * 60 * 60_000).toISOString(),
      resumedAt: at.toISOString() }));
    let current = at;
    const events = [
      { id: 1, at: new Date(at.getTime() - 60_000).toISOString(), type: 'buy_confirmed',
        ticker: 'NVDA', amountUsdg: '5', txHash: tx('a') },
      { id: 2, at: new Date(at.getTime() + 10_000).toISOString(), type: 'buy_confirmed',
        ticker: 'NVDA', amountUsdg: '5', txHash: tx('b') },
    ];
    const posts = [];
    const recorded = [];
    const setup = { env: enabled,
      now: () => current, statePath, events: () => events,
      status: () => ({ board: null, creatorWallet: wallet,
        portfolio: { ...portfolio, checkedAt: new Date(at.getTime() + 61_000).toISOString() } }),
      record: (...entry) => recorded.push(entry),
      request: async (url, options) => {
        if (url.endsWith('/users/me')) return { status: 200, json: async () => ({ data: { username: 'ScoutBot' } }) };
        posts.push(JSON.parse(options.body).text);
        return { status: 201, json: async () => ({ data: { id: '123456789' } }) };
      },
    };
    const publisher = new SocialPublisher(setup);
    current = new Date(at.getTime() + 60_000);
    await publisher.flush();
    assert.equal(posts.length, 1);
    assert.equal(recorded.filter(entry => entry[0] === 'x_post_pause_removed').length, 1);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.postingBlockedUntil, undefined);
    assert.equal(state.attempts['buy_confirmed:' + tx('a')], undefined);
    assert.equal(state.attempts['buy_confirmed:' + tx('b')].status, 'posted');
    await new SocialPublisher(setup).flush();
    assert.equal(posts.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('market recap uses fresh verified board figures and at most one post per ET date', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const calls = [];
    const posts = [];
    const board = { checkedAt: at.toISOString(), nyseOpenNow: false,
      rows: [{ ticker: 'AAPL', onchain: 95, close: 100, discount: 5, eligible: true }] };
    const setup = { env: { ...enabled, OPENAI_API_KEY: 'draft-key' }, now: () => at,
      statePath: join(directory, 'x-posting.json'), events: () => [], status: () => ({ board }), record: () => {},
      request: async (url, options) => {
        calls.push(url);
        if (url === 'https://api.x.com/2/users/me') return { status: 200,
          json: async () => ({ data: { username: 'ScoutBot' } }) };
        if (url.includes('openai.com')) return { ok: true, json: async () => ({ status: 'completed',
          output: [{ content: [{ type: 'output_text', text: 'A fresh comparison is available.' }] }] }) };
        posts.push(JSON.parse(options.body).text);
        return { status: 201, json: async () => ({ data: { id: '12345' } }) };
      } };
    const publisher = new SocialPublisher(setup);
    await publisher.flush({ cycleSuccess: true });
    await publisher.flush({ cycleSuccess: true });
    assert.equal(calls.filter(url => url.includes('openai.com')).length, 1);
    assert.equal(posts.length, 1);
    assert.match(posts[0], /AAPL 5 USDG pool quote \$95\.00 per Stock Token, 5\.00% below the last NYSE close of \$100\.00/);
    assert.match(posts[0], /no purchase implied/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('token for the wrong X account blocks all posting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-social-'));
  try {
    const event = { id: 1, at: at.toISOString(), type: 'api_paid', ticker: 'AAPL', amountUsdg: '0.05', txHash: tx('d') };
    const calls = [];
    const publisher = new SocialPublisher({ env: enabled, now: () => at,
      statePath: join(directory, 'x-posting.json'), events: () => [event], status: () => ({ board: null }),
      record: () => {}, request: async url => {
        calls.push(url);
        return { status: 200, json: async () => ({ data: { username: 'PersonalAccount' } }) };
      } });
    await assert.rejects(publisher.flush(), /does not match/);
    assert.deepEqual(calls, ['https://api.x.com/2/users/me']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
