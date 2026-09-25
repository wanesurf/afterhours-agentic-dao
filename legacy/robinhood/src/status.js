import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatUnits, isAddress, isAddressEqual, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AFTERHOURS, CHAIN_ID, config, EXPLORER } from './config.js';
import { POOLS } from './v3.js';
import { GAS_POOL_ID } from './gas-refill.js';
import { rememberPreopenPortfolio } from './exit-benchmark.js';
import { publicBuyHistory } from './buy-history.js';
import { ogTreasurySnapshot, renderTreasuryOg } from './og-image.js';
import { createWebChat } from './chat.js';

const startedAt = new Date().toISOString();
const publicAddress = process.env.AGENT_PUBLIC_ADDRESS || '';
if (publicAddress && !isAddress(publicAddress)) throw new Error('Invalid AGENT_PUBLIC_ADDRESS');
const signedAddress = /^0x[0-9a-fA-F]{64}$/.test(config.privateKey) ? privateKeyToAccount(config.privateKey).address : null;
if (signedAddress && publicAddress && !isAddressEqual(signedAddress, publicAddress)) {
  throw new Error('AGENT_PUBLIC_ADDRESS does not match the configured private key');
}
export const creatorWallet = signedAddress || publicAddress || null;
const dataPath = resolve('.data/public-activity.json');
const exitBenchmarkPath = resolve('.data/exit-benchmark.json');
const exitOrdersPath = resolve('.data/exit-orders.json');
const exitBasisPath = resolve('.data/exit-basis.json');
const buybackPath = resolve('.data/buyback.json');
const maxEvents = 5000;
const blankStore = () => ({
  version: 1,
  nextId: 1,
  events: [],
  board: null,
  boardHistory: [],
  funds: null,
  portfolio: null,
  fundingTransition: null,
  totals: { claims: 0, claimedAtomic: '0', apiPayments: 0, apiAtomic: '0', buys: 0, boughtAtomic: '0', gasRefills: 0, gasAtomic: '0' },
  totalCycles: 0,
  lastStartedAt: null,
  lastSucceededAt: null,
  lastCompletedAt: null,
  lastResult: 'waiting',
});
function loadStore() {
  try {
    const value = JSON.parse(readFileSync(dataPath, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.events) || !Number.isSafeInteger(value.nextId) ||
      !value.totals || !Number.isSafeInteger(value.totalCycles)) throw new Error('Invalid public activity store');
    if (!Array.isArray(value.boardHistory)) value.boardHistory = [];
    delete value.purchaseBasis;
    delete value.purchaseBasisWallet;
    if (Array.isArray(value.portfolio?.stocks)) {
      value.portfolio.stocks = value.portfolio.stocks.map(({ costBasisUsdg, estimatedProfitUsdg, ...stock }) => stock);
    }
    if (value.totals.gasRefills === undefined) value.totals.gasRefills = 0;
    if (value.totals.gasAtomic === undefined) value.totals.gasAtomic = '0';
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return blankStore();
    throw error;
  }
}
const store = loadStore();
const session = { lastStartedAt: null, lastResult: 'waiting', cycles: 0 };

function saveStore() {
  mkdirSync(resolve('.data'), { recursive: true });
  const temporary = dataPath + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(store) + '\n', { mode: 0o600 });
  renameSync(temporary, dataPath);
}

export function recordActivity(type, title, detail, options = {}) {
  const entry = {
    id: store.nextId++,
    at: new Date().toISOString(),
    type,
    title,
    detail,
    ticker: options.ticker || null,
    amountUsdg: options.amountUsdg || null,
    txHash: /^0x[0-9a-fA-F]{64}$/.test(options.txHash || '') ? options.txHash : null,
    xPostId: /^[0-9]{1,25}$/.test(options.xPostId || '') ? options.xPostId : null,
  };
  store.events.push(entry);
  if (store.events.length > maxEvents) store.events.splice(0, store.events.length - maxEvents);
  if (type === 'claim_confirmed' && entry.amountUsdg) {
    store.totals.claims += 1;
    store.totals.claimedAtomic = (BigInt(store.totals.claimedAtomic) + parseUnits(entry.amountUsdg, 6)).toString();
  }
  if (type === 'api_paid' && entry.amountUsdg) {
    store.totals.apiPayments += 1;
    store.totals.apiAtomic = (BigInt(store.totals.apiAtomic) + parseUnits(entry.amountUsdg, 6)).toString();
  }
  if (type === 'buy_confirmed' && entry.amountUsdg) {
    store.totals.buys += 1;
    store.totals.boughtAtomic = (BigInt(store.totals.boughtAtomic) + parseUnits(entry.amountUsdg, 6)).toString();
  }
  if (type === 'gas_refill_confirmed' && entry.amountUsdg) {
    store.totals.gasRefills += 1;
    store.totals.gasAtomic = (BigInt(store.totals.gasAtomic) + parseUnits(entry.amountUsdg, 6)).toString();
  }
  saveStore();
  return entry;
}

export function recordBoard(board, rows, candidateTickers) {
  // Historical Oracle spot observations must never appear on a chart of
  // executable Uniswap v3 quotes at the configured buy size.
  if (store.board?.priceSource !== board.priceSource) store.boardHistory = [];
  store.board = {
    asOf: board.asOf,
    checkedAt: new Date().toISOString(),
    nyseOpenNow: board.nyseOpenNow,
    pricePerQuoteUsdg: board.pricePerQuoteUsdg,
    priceSource: board.priceSource,
    quoteSizeUsdg: formatUnits(config.buy, 6),
    candidateTickers,
    rows,
  };
  store.boardHistory.push({
    asOf: board.asOf,
    checkedAt: store.board.checkedAt,
    rows: rows.map(row => ({
      ticker: row.ticker,
      onchain: row.onchain,
      close: row.close,
      discount: row.discount,
    })),
  });
  if (store.boardHistory.length > 400) store.boardHistory.splice(0, store.boardHistory.length - 400);
  saveStore();
}

export function recordFunds(funds) {
  store.funds = { ...funds, wallet: creatorWallet, checkedAt: new Date().toISOString() };
  saveStore();
}

export function recordPortfolio(portfolio) {
  if (!creatorWallet || !isAddressEqual(portfolio.wallet, creatorWallet)) {
    throw new Error('Portfolio wallet does not match the configured agent wallet');
  }
  store.portfolio = portfolio;
  saveStore();
  rememberPreopenPortfolio(portfolio, store.board);
}

export function recordFundingTransition(migration) {
  if (store.fundingTransition) {
    if (store.fundingTransition.at !== migration.at) throw new Error('Funding transition record mismatch');
    return;
  }
  store.fundingTransition = {
    from: 'wallet', to: 'creator-fees', at: migration.at,
    baseline: {
      apiPayments: store.totals.apiPayments, apiAtomic: store.totals.apiAtomic,
      buys: store.totals.buys, boughtAtomic: store.totals.boughtAtomic,
      gasRefills: store.totals.gasRefills, gasAtomic: store.totals.gasAtomic,
    },
  };
  recordActivity('funding_switched', 'Pons creator fees became the funding source',
    'The verified Pons token pays USDG to this wallet. Earlier wallet-funded spending remains in all-time totals; new spending requires verified creator-fee claims.');
}

export function markCycleStarted() {
  session.lastStartedAt = new Date().toISOString();
  store.lastStartedAt = session.lastStartedAt;
  session.lastResult = 'running';
  recordActivity('cycle_started', 'Market check started', 'Fetching the free After-Hours Oracle board.');
}

export function markCycleFinished(success) {
  const now = new Date().toISOString();
  session.lastResult = success ? 'success' : 'failed';
  session.cycles += 1;
  store.lastResult = session.lastResult;
  store.lastCompletedAt = now;
  store.totalCycles += 1;
  if (success) store.lastSucceededAt = now;
  recordActivity(success ? 'cycle_completed' : 'cycle_failed',
    success ? 'Market check completed' : 'Market check failed',
    success ? 'The agent completed this evaluation cycle.' : 'The cycle stopped before completion. See the operator logs for diagnostics.');
}

export function activityAfter(id = 0) {
  return store.events.filter(event => event.id > id);
}

export function recordedExitCosts() {
  return {
    acquiredUsdg: BigInt(store.totals.boughtAtomic),
    oracleUsdg: BigInt(store.totals.apiAtomic),
    buys: store.totals.buys,
  };
}

export function recordedPortfolio() {
  return store.portfolio;
}

function verifiedAcquisitionCost() {
  if (!creatorWallet) return null;
  let basis;
  try { basis = JSON.parse(readFileSync(exitBasisPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (basis.version !== 1 || !isAddress(basis.wallet || '') ||
      !isAddressEqual(basis.wallet, creatorWallet) ||
      ['AAPL', 'NVDA'].some(ticker => !/^\d+$/.test(basis[ticker]?.spentUsdg || ''))) {
    throw new Error('Verified acquisition ledger is invalid');
  }
  return BigInt(basis.AAPL.spentUsdg) + BigInt(basis.NVDA.spentUsdg);
}

function publicExitBenchmark() {
  try {
    const benchmark = JSON.parse(readFileSync(exitBenchmarkPath, 'utf8'));
    if (benchmark.version !== 1 || !creatorWallet ||
        !isAddressEqual(benchmark.wallet, creatorWallet) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(benchmark.date) ||
        !/^\d+$/.test(benchmark.totalUsdg) || !/^\d+$/.test(benchmark.cashUsdg)) return null;
    return {
      date: benchmark.date,
      capturedAt: benchmark.capturedAt,
      treasuryValueUsdg: formatUnits(BigInt(benchmark.totalUsdg), 6),
      stockValueUsdg: formatUnits(BigInt(benchmark.totalUsdg) - BigInt(benchmark.cashUsdg), 6),
      minimumImprovementUsdg: formatUnits(config.exitMinProfitUsdg, 6),
    };
  } catch { return null; }
}

export function publicExits() {
  const verifiedCost = verifiedAcquisitionCost();
  let ledger;
  try { ledger = JSON.parse(readFileSync(exitOrdersPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (store.events.some(event => event.type === 'exit_filled')) {
        throw new Error('Confirmed sale activity exists without an exit ledger');
      }
      return { available: true, count: 0,
        pendingCount: 0,
        totalVerifiedAcquisitionUsdg: verifiedCost === null ? null : formatUnits(verifiedCost, 6),
        totalAcquisitionUsdg: '0', totalProceedsUsdg: '0', grossSpreadUsdg: '0', sales: [] };
    }
    throw error;
  }
  if (ledger.version !== 1 || !creatorWallet || !isAddress(ledger.wallet || '') ||
      !isAddressEqual(ledger.wallet, creatorWallet)) throw new Error('Exit ledger wallet mismatch');
  const sales = [];
  let pendingCount = 0;
  let totalCost = 0n;
  let totalProceeds = 0n;
  for (const ticker of ['AAPL', 'NVDA']) {
    const record = ledger[ticker];
    if (!record || !Array.isArray(record.history) || !/^\d+$/.test(record.soldQuantity || '') ||
        !/^\d+$/.test(record.soldCostUsdg || '')) throw new Error('Invalid exit ledger record');
    if (record.pending) pendingCount++;
    let tickerQuantity = 0n;
    let tickerCost = 0n;
    for (const entry of record.history) {
      if (entry.orderStatus !== 'filled') continue;
      if (!/^\d+$/.test(entry.amount || '') || !/^\d+$/.test(entry.acquisitionCostUsdg || '') ||
          !/^\d+$/.test(entry.receivedUsdg || '') ||
          !/^0x[0-9a-fA-F]{64}$/.test(entry.txHash || '') ||
          (entry.filledAt != null && !Number.isFinite(Date.parse(entry.filledAt)))) {
        throw new Error('Invalid confirmed exit');
      }
      const quantity = BigInt(entry.amount);
      const cost = BigInt(entry.acquisitionCostUsdg);
      const proceeds = BigInt(entry.receivedUsdg);
      tickerQuantity += quantity;
      tickerCost += cost;
      totalCost += cost;
      totalProceeds += proceeds;
      sales.push({ ticker, quantity: formatUnits(quantity, 18),
        acquisitionCostUsdg: formatUnits(cost, 6), proceedsUsdg: formatUnits(proceeds, 6),
        grossSpreadUsdg: formatUnits(proceeds - cost, 6),
        filledAt: entry.filledAt || null, txHash: entry.txHash });
    }
    if (tickerQuantity !== BigInt(record.soldQuantity) || tickerCost !== BigInt(record.soldCostUsdg)) {
      throw new Error('Confirmed exits do not match ledger totals');
    }
  }
  sales.sort((a, b) => (b.filledAt ? Date.parse(b.filledAt) : 0) -
    (a.filledAt ? Date.parse(a.filledAt) : 0));
  if (verifiedCost !== null && totalCost > verifiedCost) throw new Error('Confirmed sale cost exceeds verified acquisitions');
  return { available: true, count: sales.length, pendingCount,
    totalVerifiedAcquisitionUsdg: verifiedCost === null ? null : formatUnits(verifiedCost, 6),
    totalAcquisitionUsdg: formatUnits(totalCost, 6),
    totalProceedsUsdg: formatUnits(totalProceeds, 6),
    grossSpreadUsdg: formatUnits(totalProceeds - totalCost, 6), sales };
}

export function publicBuybacks() {
  let ledger;
  try { ledger = JSON.parse(readFileSync(buybackPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: true, enabled: config.buybackEnabled,
      count: 0, pending: false, totalSpentUsdg: '0', totalBurned: '0', burns: [] };
    throw error;
  }
  if (ledger.version !== 1 || !creatorWallet || !isAddressEqual(ledger.wallet, creatorWallet) ||
      !isAddressEqual(ledger.token, AFTERHOURS) ||
      !Array.isArray(ledger.history) || !/^\d+$/.test(ledger.spentUsdg || '') ||
      !/^\d+$/.test(ledger.burned || '')) throw new Error('Buyback ledger invalid');
  const burns = ledger.history.slice().reverse().map(entry => ({
    at: entry.at, spentUsdg: formatUnits(BigInt(entry.spentUsdg), 6),
    burned: formatUnits(BigInt(entry.burned), 18),
    swapTxHash: entry.swapTxHash, burnTxHash: entry.burnTxHash,
  }));
  if (burns.reduce((sum, entry) => sum + parseUnits(entry.spentUsdg, 6), 0n) !==
      BigInt(ledger.spentUsdg) ||
      burns.reduce((sum, entry) => sum + parseUnits(entry.burned, 18), 0n) !==
      BigInt(ledger.burned)) throw new Error('Buyback ledger totals differ from history');
  return { available: true, enabled: config.buybackEnabled, count: burns.length,
    pending: Boolean(ledger.pending), totalSpentUsdg: formatUnits(BigInt(ledger.spentUsdg), 6),
    totalBurned: formatUnits(BigInt(ledger.burned), 18), burns };
}

export function publicStatus() {
  const freshnessMs = Math.max(config.pollMinutes * 2 * 60_000, 10 * 60_000);
  const stale = !store.lastSucceededAt || Date.now() - Date.parse(store.lastSucceededAt) > freshnessMs;
  const lastResult = session.lastResult === 'waiting' ? store.lastResult : session.lastResult;
  const baseline = store.fundingTransition?.baseline;
  const creatorFeeTotals = {
    apiPayments: store.totals.apiPayments - (baseline?.apiPayments || 0),
    apiPaidUsdg: formatUnits(BigInt(store.totals.apiAtomic) - BigInt(baseline?.apiAtomic || '0'), 6),
    buys: store.totals.buys - (baseline?.buys || 0),
    boughtUsdg: formatUnits(BigInt(store.totals.boughtAtomic) - BigInt(baseline?.boughtAtomic || '0'), 6),
    gasRefills: store.totals.gasRefills - (baseline?.gasRefills || 0),
    gasSpentUsdg: formatUnits(BigInt(store.totals.gasAtomic) - BigInt(baseline?.gasAtomic || '0'), 6),
  };
  return {
    agent: 'Afterhours Agent',
    network: 'Robinhood Chain',
    chainId: CHAIN_ID,
    mode: config.live ? 'live' : 'read-only',
    fundingMode: config.fundingMode,
    walletBudgetUsdg: config.fundingMode === 'wallet' ? formatUnits(config.walletBudget, 6) : null,
    status: lastResult === 'failed' ? 'degraded' : stale ? 'stale' : 'healthy',
    startedAt,
    lastStartedAt: session.lastStartedAt || store.lastStartedAt || null,
    lastCompletedAt: store.lastCompletedAt,
    lastSucceededAt: store.lastSucceededAt,
    lastResult,
    cycles: session.cycles,
    totalCycles: store.totalCycles,
    pollMinutes: config.pollMinutes,
    executionPools: Object.fromEntries(Object.entries(POOLS).map(([ticker, route]) =>
      [ticker, { address: route.pool, token: route.token, fee: route.fee }])),
    creatorWallet,
    ponsToken: config.ponsToken || null,
    fundingTransition: store.fundingTransition,
    social: {
      enabled: process.env.X_POSTING_ENABLED === 'true',
      automatedLabelConfirmed: process.env.X_AUTOMATED_LABEL_CONFIRMED === 'true',
      accountHandle: /^[A-Za-z0-9_]{1,15}$/.test(process.env.X_ACCOUNT_HANDLE || '')
        ? process.env.X_ACCOUNT_HANDLE : null,
      buysPerPost: Number(process.env.X_BUYS_PER_POST ?? '10'),
      aiMarketDrafts: Boolean(process.env.OPENAI_API_KEY && process.env.X_POSTING_ENABLED === 'true' &&
        process.env.X_BUYS_PER_POST === '0'),
      aiTransactionDrafts: Boolean(process.env.OPENAI_API_KEY && process.env.X_POSTING_ENABLED === 'true'),
    },
    explorer: EXPLORER,
    board: store.board,
    funds: store.funds?.wallet && creatorWallet && store.funds.fundingMode === config.fundingMode &&
      isAddressEqual(store.funds.wallet, creatorWallet) ? store.funds : null,
    portfolio: store.portfolio?.wallet && creatorWallet &&
      isAddressEqual(store.portfolio.wallet, creatorWallet) ? store.portfolio : null,
    exitBenchmark: publicExitBenchmark(),
    totals: {
      claims: store.totals.claims,
      claimedUsdg: formatUnits(BigInt(store.totals.claimedAtomic), 6),
      apiPayments: store.totals.apiPayments,
      apiPaidUsdg: formatUnits(BigInt(store.totals.apiAtomic), 6),
      buys: store.totals.buys,
      boughtUsdg: formatUnits(BigInt(store.totals.boughtAtomic), 6),
      gasRefills: store.totals.gasRefills,
      gasSpentUsdg: formatUnits(BigInt(store.totals.gasAtomic), 6),
    },
    creatorFeeTotals,
    policy: {
      exitEnabled: config.exitEnabled,
      buybackEnabled: config.buybackEnabled,
      exitWindowMinutes: config.exitWindowMinutes,
      exitMinProfitUsdg: formatUnits(config.exitMinProfitUsdg, 6),
      minDiscountPct: config.minDiscount,
      minExecutionDiscountPct: config.minExecutionDiscount,
      buyUsdg: formatUnits(config.buy, 6),
      maxDailyUsdg: formatUnits(config.maxDaily, 6),
      maxApiDailyUsdg: formatUnits(config.maxApiDaily, 6),
      maxApiFeeUsdg: formatUnits(config.maxApiFee, 6),
      exitCostBufferPct: config.exitCostBufferPct,
      minExpectedNetProfitPct: config.minExpectedNetProfitPct,
      estimatedGasUnitsPerLeg: config.estimatedGasUnitsPerLeg,
      maxBuysPerDay: config.maxBuysPerDay,
      maxSignalAgeSeconds: config.maxSignalAgeSeconds,
      autoGasRefillEnabled: config.autoGasRefill,
      gasRefillPoolId: GAS_POOL_ID,
      gasRefillUsdg: formatUnits(config.gasRefillUsdg, 6),
      maxGasRefillDailyUsdg: formatUnits(config.maxGasRefillDaily, 6),
    },
    activity: store.events.slice(-60).reverse(),
    activityRetained: store.events.length,
  };
}

function activityPage(searchParams) {
  const requested = Number(searchParams.get('limit') || '50');
  const limit = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 50;
  const before = Number(searchParams.get('before') || store.nextId);
  const cursor = Number.isSafeInteger(before) && before > 0 ? before : store.nextId;
  const matching = store.events.filter(event => event.id < cursor).reverse();
  const events = matching.slice(0, limit);
  return { events, hasMore: matching.length > limit, nextBefore: events.at(-1)?.id || null, retained: store.events.length };
}

function historyPage(searchParams) {
  const ticker = searchParams.get('ticker') || 'AAPL';
  if (!['NVDA', 'AAPL'].includes(ticker)) return null;
  const requested = Number(searchParams.get('hours') || '24');
  const hours = [6, 24, 168].includes(requested) ? requested : 24;
  const since = Date.now() - hours * 60 * 60 * 1000;
  const points = store.boardHistory.filter(snapshot => Date.parse(snapshot.checkedAt) >= since)
    .map(snapshot => {
      const row = snapshot.rows.find(item => item.ticker === ticker);
      return row && Number.isFinite(row.onchain) && Number.isFinite(row.close)
        ? { at: snapshot.checkedAt, asOf: snapshot.asOf, price: row.onchain, close: row.close, discount: row.discount }
        : null;
    }).filter(Boolean);
  return { ticker, hours, points, source: `${formatUnits(config.buy, 6)} USDG quotes from verified Uniswap v3 pools; NYSE close from After-Hours Oracle` };
}

export async function startStatusServer(port = process.env.PORT || '3000') {
  const n = Number(port);
  if (!Number.isSafeInteger(n) || n < 0 || n > 65535) throw new Error('Invalid PORT');
  const assets = {
    '/': ['text/html; charset=utf-8', readFileSync(resolve('public/index.html'))],
    '/dashboard.css': ['text/css; charset=utf-8', readFileSync(resolve('public/dashboard.css'))],
    '/app.js': ['text/javascript; charset=utf-8', readFileSync(resolve('public/app.js'))],
    '/decisions.html': ['text/html; charset=utf-8', readFileSync(resolve('public/decisions.html'))],
    '/decisions.css': ['text/css; charset=utf-8', readFileSync(resolve('public/decisions.css'))],
    '/decisions.js': ['text/javascript; charset=utf-8', readFileSync(resolve('public/decisions.js'))],
    '/dao-config.json': ['application/json; charset=utf-8', readFileSync(resolve('public/dao-config.json'))],
    '/afterhours-robot.png': ['image/png', readFileSync(resolve('public/afterhours-robot.png'))],
    '/og-afterhours.png': ['image/png', readFileSync(resolve('public/og-afterhours.png'))],
    '/og-afterhours-v2.png': ['image/png', readFileSync(resolve('public/og-afterhours.png'))],
    '/favicon.svg': ['image/svg+xml', readFileSync(resolve('public/favicon.svg'))],
  };
  const indexTemplate = assets['/'][1].toString('utf8');
  let renderedOg = null;
  const handleChat = createWebChat({ status: publicStatus, exits: publicExits, buybacks: publicBuybacks });
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.url?.split('?')[0] === '/chat.json') {
      if (req.method === 'POST') void handleChat(req, res);
      else res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ok\n');
    } else if (url.pathname === '/status.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(publicStatus()) + '\n');
    } else if (url.pathname === '/exits.json') {
      try {
        const exits = publicExits();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(exits) + '\n');
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ available: false, error: 'Confirmed exit ledger unavailable' }) + '\n');
      }
    } else if (url.pathname === '/buybacks.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify(publicBuybacks()) + '\n');
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ available: false, error: 'Buyback ledger unavailable' }) + '\n');
      }
    } else if (url.pathname === '/buys.json') {
      const ticker = url.searchParams.get('ticker');
      if (!['AAPL', 'NVDA'].includes(ticker)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ error: 'Unsupported ticker' }) + '\n');
      } else {
        try {
          const buys = publicBuyHistory(creatorWallet, ticker);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(buys) + '\n');
        } catch {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ available: false, error: 'Purchase receipt index unavailable' }) + '\n');
        }
      }
    } else if (url.pathname === '/activity.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(activityPage(url.searchParams)) + '\n');
    } else if (url.pathname === '/history.json') {
      const result = historyPage(url.searchParams);
      res.writeHead(result ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(result || { error: 'Unsupported ticker' }) + '\n');
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(indexTemplate);
    } else if (url.pathname === '/og-treasury.png') {
      const snapshot = ogTreasurySnapshot(publicStatus().portfolio);
      if (!renderedOg || renderedOg.version !== snapshot.version || renderedOg.amount !== snapshot.amount) {
        renderedOg = { ...snapshot, image: renderTreasuryOg(snapshot) };
      }
      renderedOg.image.then(data => {
        res.writeHead(200, { 'Content-Type': 'image/png' }).end(data);
      }).catch(error => {
        console.error('OG image rendering failed:', error);
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OG image unavailable\n');
      });
    } else if (assets[url.pathname]) {
      const [contentType, data] = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': contentType }).end(data);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(n, '0.0.0.0', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  console.log('Public dashboard listening on port ' + server.address().port);
  return server;
}
