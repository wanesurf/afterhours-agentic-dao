import { publicClient } from './chain.js';
import { quoteGasRefill } from './gas-refill.js';

const USDG_FOR_GAS_QUOTE = 10_000000n;
const TOKEN_SCALE = 10n ** 18n;

function ceilDiv(value, divisor) {
  return (value + divisor - 1n) / divisor;
}

// The approved ETH/USDG pool gives a conservative USDG price for native gas.
// Each leg reserves enough gas for an allowance transaction and a swap.
export async function estimateRoundTripGasUsdg(gasUnitsPerLeg, {
  client = publicClient, quote = quoteGasRefill,
} = {}) {
  if (!Number.isSafeInteger(gasUnitsPerLeg) || gasUnitsPerLeg <= 0) throw new Error('Invalid gas units per leg');
  const [gasPrice, ethQuote] = await Promise.all([
    client.getGasPrice(), quote(USDG_FOR_GAS_QUOTE, client),
  ]);
  if (gasPrice <= 0n || !ethQuote?.amountOut || ethQuote.amountOut <= 0n) {
    throw new Error('Live gas price or approved ETH/USDG quote is unavailable');
  }
  const roundTripGasWei = gasPrice * BigInt(gasUnitsPerLeg) * 2n;
  return ceilDiv(roundTripGasWei * USDG_FOR_GAS_QUOTE, ethQuote.amountOut);
}

// This is a conservative convergence estimate, not a guaranteed arbitrage.
// minOut includes the buy-side pool fee, price impact, and permitted slippage.
export function projectedNetProfitAtClose({
  minOut, referenceClose, buyUsdg, oracleFeeUsdg, gasUsdg,
  exitCostBufferPct, minExpectedNetProfitPct,
}) {
  if (minOut <= 0n || buyUsdg <= 0n || oracleFeeUsdg < 0n || gasUsdg < 0n ||
    !Number.isFinite(referenceClose) || referenceClose <= 0 ||
    !Number.isFinite(exitCostBufferPct) || exitCostBufferPct < 0 || exitCostBufferPct >= 100 ||
    !Number.isFinite(minExpectedNetProfitPct) || minExpectedNetProfitPct < 0 || minExpectedNetProfitPct >= 100) {
    throw new Error('Invalid expected-profit inputs');
  }
  const closeAtomic = BigInt(Math.floor(referenceClose * 1_000_000));
  if (closeAtomic <= 0n) throw new Error('Reference close is too small');
  const referenceSaleUsdg = minOut * closeAtomic / TOKEN_SCALE;
  const exitCostBps = BigInt(Math.ceil(exitCostBufferPct * 100));
  const estimatedSaleUsdg = referenceSaleUsdg * (10_000n - exitCostBps) / 10_000n;
  const estimatedNetProfitUsdg = estimatedSaleUsdg - buyUsdg - oracleFeeUsdg - gasUsdg;
  const minimumProfitBps = BigInt(Math.ceil(minExpectedNetProfitPct * 100));
  const minimumProfitUsdg = ceilDiv(buyUsdg * minimumProfitBps, 10_000n);
  return {
    estimatedNetProfitUsdg,
    minimumProfitUsdg,
    estimatedSaleUsdg,
    passes: minExpectedNetProfitPct === 0 || estimatedNetProfitUsdg >= minimumProfitUsdg,
  };
}
