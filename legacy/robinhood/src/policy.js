import { formatUnits, parseUnits } from 'viem';
import { WATCHLIST } from './config.js';

export function fresh(iso, maxAgeSeconds, now = Date.now()) {
  const time = Date.parse(iso);
  return Number.isFinite(time) && time <= now + 10_000 && now - time <= maxAgeSeconds * 1000;
}

export function validClose(date, maxDays, now = Date.now()) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && time <= now && now - time <= maxDays * 86_400_000;
}

export function candidates(board, c, now = Date.now()) {
  if (board.nyseOpenNow !== false || !fresh(board.asOf, c.maxSignalAgeSeconds, now)) return [];
  if (!Array.isArray(board.prices)) return [];
  return board.prices.filter(s => WATCHLIST.includes(s.ticker) && s.tradable === true &&
    Number.isFinite(s.discount) && s.discount >= c.minDiscount &&
    Number.isFinite(s.close) && s.close > 0 && validClose(s.closeDate, c.maxCloseAgeDays, now))
    .sort((a, b) => b.discount - a.discount);
}

// Mirrors the free-board screen so the public dashboard can explain each decision.
export function screenBoard(board, c, now = Date.now()) {
  const prices = Array.isArray(board.prices) ? board.prices : [];
  return WATCHLIST.map(ticker => {
    const item = prices.find(price => price.ticker === ticker);
    const reasons = [];
    if (board.nyseOpenNow !== false) reasons.push('NYSE is open or its state is unavailable');
    if (!fresh(board.asOf, c.maxSignalAgeSeconds, now)) reasons.push('Oracle snapshot is stale');
    if (!item) reasons.push('No price in the Oracle board');
    else {
      if (item.tradable !== true) reasons.push('Stock Token is unavailable');
      if (!Number.isFinite(item.onchain) || item.onchain <= 0) reasons.push('Approved pool quote is unavailable');
      else if (!Number.isFinite(item.discount) || item.discount < c.minDiscount) reasons.push('Discount is below the screen');
      if (!Number.isFinite(item.close) || item.close <= 0 || !validClose(item.closeDate, c.maxCloseAgeDays, now)) {
        reasons.push('NYSE close is missing or stale');
      }
    }
    return {
      ticker,
      name: item?.name || ticker,
      tradable: item?.tradable === true,
      onchain: Number.isFinite(item?.onchain) ? item.onchain : null,
      close: Number.isFinite(item?.close) ? item.close : null,
      closeDate: item?.closeDate || null,
      discount: Number.isFinite(item?.discount) ? item.discount : null,
      pool: item?.pool || null,
      eligible: reasons.length === 0,
      reasons,
    };
  });
}

export function validatePaidSignal(signal, ticker, c, now = Date.now()) {
  if (signal.ticker !== ticker || signal.nyseOpenNow !== false ||
    !fresh(signal.asOf, c.maxSignalAgeSeconds, now) ||
    !validClose(signal.lastNyseCloseDate, c.maxCloseAgeDays, now) ||
    !Number.isFinite(signal.lastNyseClose) || signal.lastNyseClose <= 0 ||
    signal.source?.chain !== 'Robinhood Chain (eip155:4663)') {
    throw new Error(`Paid ${ticker} signal failed freshness, market, source, or close policy`);
  }
}

export function routeDiscount(price, close, c) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(close) || close <= 0) {
    throw new Error('Executable pool price or NYSE close is invalid');
  }
  const discount = (close - price) / close * 100;
  if (discount < c.minDiscount) throw new Error(`Executable pool discount ${discount.toFixed(2)}% is below ${c.minDiscount}%`);
  return discount;
}

export function executionFloor(signal, atomicIn, atomicOut, c) {
  if (atomicOut <= 0n) throw new Error('No executable stock output');
  const input = Number(formatUnits(atomicIn, 6));
  const output = Number(formatUnits(atomicOut, 18));
  const routePrice = input / output;
  const maxPrice = signal.lastNyseClose * (1 - c.minExecutionDiscount / 100);
  if (!Number.isFinite(routePrice) || routePrice > signal.onchainPrice * (1 + c.maxRouteMarkup / 100) || routePrice > maxPrice) {
    throw new Error(`Executable route ${routePrice.toFixed(4)} USDG exceeds oracle or close limit`);
  }
  const bps = Math.floor(c.maxSlippage * 100);
  const slippageFloor = atomicOut * BigInt(10000 - bps) / 10000n;
  // The router enforces the stricter of the route slippage and maximum
  // acceptable price versus the official close, even if the quote changes.
  const priceFloor = parseUnits((input / maxPrice).toFixed(18), 18) + 1n;
  if (priceFloor > atomicOut) throw new Error('Quoted route cannot satisfy execution price floor');
  return { routePrice, minOut: priceFloor > slippageFloor ? priceFloor : slippageFloor };
}
