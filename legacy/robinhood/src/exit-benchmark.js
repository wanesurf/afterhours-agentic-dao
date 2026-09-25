import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isAddressEqual, parseUnits } from 'viem';
import { WATCHLIST } from './config.js';

const defaultPath = resolve('.data/exit-benchmark.json');
const defaultPreopenPath = resolve('.data/exit-preopen.json');
const decimal = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
const atomic = value => typeof value === 'string' && /^\d+$/.test(value);

function easternParts(time) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(time));
  const value = type => parts.find(part => part.type === type)?.value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`,
    minuteOfDay: Number(value('hour')) * 60 + Number(value('minute')) };
}

function validate(benchmark, wallet) {
  if (benchmark?.version !== 1 || typeof benchmark.wallet !== 'string' ||
      !isAddressEqual(benchmark.wallet, wallet) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(benchmark.date || '') ||
      !atomic(benchmark.totalUsdg) || !atomic(benchmark.cashUsdg) ||
      WATCHLIST.some(ticker => !atomic(benchmark.positions?.[ticker]?.quantity) ||
        !atomic(benchmark.positions?.[ticker]?.valueUsdg) ||
        !atomic(benchmark.positions?.[ticker]?.soldAtCapture))) {
    throw new Error('Pre-open treasury benchmark is invalid or belongs to another wallet');
  }
  const total = BigInt(benchmark.cashUsdg) + WATCHLIST.reduce((sum, ticker) =>
    sum + BigInt(benchmark.positions[ticker].valueUsdg), 0n);
  if (total !== BigInt(benchmark.totalUsdg)) throw new Error('Pre-open treasury benchmark total is inconsistent');
  return benchmark;
}

function eligibleSnapshot(snapshot, wallet, now) {
  const capturedAt = Date.parse(snapshot?.checkedAt);
  const capturedEastern = Number.isFinite(capturedAt) ? easternParts(capturedAt) : null;
  return Boolean(snapshot?.valuationComplete && typeof snapshot.wallet === 'string' &&
    isAddressEqual(snapshot.wallet, wallet) && capturedEastern &&
    capturedEastern.date === easternParts(now).date &&
    capturedEastern.minuteOfDay < 9 * 60 + 30 &&
    capturedAt <= now && now - capturedAt <= 10 * 60_000 &&
    decimal.test(snapshot.cashUsdg || '') && decimal.test(snapshot.estimatedTotalUsdg || ''));
}

export function rememberPreopenPortfolio(snapshot, board, path = defaultPreopenPath) {
  const checkedAt = Date.parse(snapshot?.checkedAt);
  const boardAt = Date.parse(board?.asOf);
  if (board?.nyseOpenNow !== false || !Number.isFinite(checkedAt) ||
      !Number.isFinite(boardAt) || checkedAt < boardAt ||
      checkedAt - boardAt > 5 * 60_000 ||
      !eligibleSnapshot(snapshot, snapshot.wallet, checkedAt)) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  return true;
}

// Lock the latest complete pre-open valuation from the same trading date.
// Later creator-fee claims cannot be mistaken for a profitable stock exit.
export function loadOrCaptureExitBenchmark(wallet, snapshot, orders, now = Date.now(),
  path = defaultPath, preopenPath = defaultPreopenPath) {
  const today = easternParts(now).date;
  try {
    const saved = validate(JSON.parse(readFileSync(path, 'utf8')), wallet);
    if (saved.date === today) return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!eligibleSnapshot(snapshot, wallet, now)) {
    try { snapshot = JSON.parse(readFileSync(preopenPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!eligibleSnapshot(snapshot, wallet, now)) {
    throw new Error('No fresh complete pre-open treasury value is available to set the sell target');
  }
  const positions = {};
  for (const ticker of WATCHLIST) {
    const stock = snapshot.stocks?.find(item => item.ticker === ticker);
    if (!stock || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(stock.quantity || '') ||
        !decimal.test(stock.estimatedSellUsdg || '')) {
      throw new Error(`${ticker} pre-open valuation is incomplete`);
    }
    positions[ticker] = {
      quantity: parseUnits(stock.quantity, 18).toString(),
      valueUsdg: parseUnits(stock.estimatedSellUsdg, 6).toString(),
      soldAtCapture: orders[ticker].soldQuantity,
    };
  }
  const benchmark = validate({ version: 1, wallet, date: today,
    capturedAt: snapshot.checkedAt,
    totalUsdg: parseUnits(snapshot.estimatedTotalUsdg, 6).toString(),
    cashUsdg: parseUnits(snapshot.cashUsdg, 6).toString(), positions }, wallet);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(benchmark, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  return benchmark;
}
