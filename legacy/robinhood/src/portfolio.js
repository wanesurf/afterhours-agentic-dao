import { formatEther, formatUnits, parseAbi } from 'viem';
import { AFTERHOURS, CHAIN_ID, USDG, WATCHLIST } from './config.js';
import { publicClient } from './chain.js';
import { POOLS, quoteStockToUsdg } from './v3.js';
import { AFTERHOURS_POOL_ID, quoteAfterhoursToUsdg } from './afterhours-valuation.js';

const balanceAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

export async function readPortfolio(wallet, { client = publicClient, quote = quoteStockToUsdg,
  quoteAfterhours = quoteAfterhoursToUsdg } = {}) {
  if (await client.getChainId() !== CHAIN_ID) throw new Error('Wrong RPC chain for portfolio');
  const [cashAtomic, gasAtomic, afterhoursBalanceAtomic, ...stockBalances] = await Promise.all([
    client.readContract({ address: USDG, abi: balanceAbi, functionName: 'balanceOf', args: [wallet] }),
    client.getBalance({ address: wallet }),
    client.readContract({ address: AFTERHOURS, abi: balanceAbi, functionName: 'balanceOf', args: [wallet] }),
    ...WATCHLIST.map(ticker => client.readContract({
      address: POOLS[ticker].token, abi: balanceAbi, functionName: 'balanceOf', args: [wallet],
    })),
  ]);
  const positions = await Promise.all(WATCHLIST.map(async (ticker, index) => {
    const quantityAtomic = stockBalances[index];
    let sellValueAtomic = 0n;
    let valuationAvailable = true;
    if (quantityAtomic > 0n) {
      try { sellValueAtomic = await quote(ticker, quantityAtomic, client); }
      catch { valuationAvailable = false; }
    }
    return {
      ticker,
      token: POOLS[ticker].token,
      pool: POOLS[ticker].pool,
      quantity: formatUnits(quantityAtomic, 18),
      sellValueAtomic: valuationAvailable ? sellValueAtomic : null,
    };
  }));
  const valuationComplete = positions.every(stock => stock.sellValueAtomic !== null);
  const sellTotal = positions.reduce((sum, stock) => sum + (stock.sellValueAtomic ?? 0n), 0n);
  let afterhoursSellAtomic = 0n;
  if (afterhoursBalanceAtomic > 0n) {
    try { afterhoursSellAtomic = await quoteAfterhours(afterhoursBalanceAtomic, client); }
    catch { afterhoursSellAtomic = null; }
  }
  const treasuryValuationComplete = valuationComplete && afterhoursSellAtomic !== null;
  const stocks = positions.map(({ sellValueAtomic, ...stock }) => ({
    ...stock,
    estimatedSellUsdg: sellValueAtomic === null ? null : formatUnits(sellValueAtomic, 6),
  }));
  return {
    wallet,
    checkedAt: new Date().toISOString(),
    cashUsdg: formatUnits(cashAtomic, 6),
    gasEth: formatEther(gasAtomic),
    stocks,
    afterhours: {
      token: AFTERHOURS,
      poolId: AFTERHOURS_POOL_ID,
      quantity: formatUnits(afterhoursBalanceAtomic, 18),
      estimatedSellUsdg: afterhoursSellAtomic === null ? null : formatUnits(afterhoursSellAtomic, 6),
    },
    valuationComplete,
    estimatedTotalUsdg: valuationComplete ? formatUnits(cashAtomic + sellTotal, 6) : null,
    treasuryValuationComplete,
    estimatedTreasuryUsdg: treasuryValuationComplete
      ? formatUnits(cashAtomic + sellTotal + afterhoursSellAtomic, 6) : null,
  };
}
