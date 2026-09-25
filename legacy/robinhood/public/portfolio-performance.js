const USDG_SCALE = 1_000_000n;

function usdgAtomic(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * USDG_SCALE + BigInt(fraction.padEnd(6, '0'));
}

function usdgString(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / USDG_SCALE;
  const fraction = String(absolute % USDG_SCALE).padStart(6, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}

// Combine confirmed sales with the quoted value of the remaining holdings.
// This is gross trading P/L against recorded buy spend, before Oracle and gas.
// Open holdings use approved pool sell estimates, not executable UniswapX
// proceeds, so this number is never presented as realized profit.
export function portfolioPerformance(portfolio, exits) {
  const soldCost = usdgAtomic(exits?.totalAcquisitionUsdg);
  const received = usdgAtomic(exits?.totalProceedsUsdg);
  const verifiedBought = usdgAtomic(exits?.totalVerifiedAcquisitionUsdg);
  if (exits?.available !== true ||
      (exits.pendingCount || 0) > 0 ||
      soldCost === null || received === null ||
      portfolio?.valuationComplete !== true || !Array.isArray(portfolio.stocks)) return null;
  let openValue = 0n;
  let hasOpenStock = false;
  for (const stock of portfolio.stocks) {
    const value = usdgAtomic(stock.estimatedSellUsdg);
    if (value === null || typeof stock.quantity !== 'string' ||
        !/^\d+(?:\.\d+)?$/.test(stock.quantity)) return null;
    if (Number(stock.quantity) > 0) hasOpenStock = true;
    openValue += value;
  }
  const bought = verifiedBought ?? (hasOpenStock ? null : soldCost);
  if (bought === null || bought <= 0n || soldCost > bought) return null;
  return {
    estimatedGrossTradingPnlUsdg: usdgString(openValue + received - bought),
    realizedGrossTradingPnlUsdg: usdgString(received - soldCost),
  };
}
