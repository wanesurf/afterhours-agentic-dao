import { decodeEventLog, decodeFunctionData, formatUnits, isAddress, isAddressEqual, parseAbi } from 'viem';
import { CHAIN_ID, USDG, config } from './config.js';
import { publicClient } from './chain.js';
import { Ledger } from './ledger.js';
import { activityAfter, recordActivity } from './status.js';
import { POOLS, V3_ROUTER, verifyPool } from './v3.js';

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const claimAbi = parseAbi(['function claimToken(address token)']);

function transferAmount(logs, token, from, to) {
  let amount = 0n;
  for (const log of logs) {
    if (!isAddressEqual(log.address, token)) continue;
    try {
      const decoded = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
      if (isAddressEqual(decoded.args.from, from) && isAddressEqual(decoded.args.to, to)) {
        amount += decoded.args.value;
      }
    } catch { /* unrelated event */ }
  }
  return amount;
}

export async function recoverConfirmedClaim(hash, wallet, {
  client = publicClient, events = activityAfter, record = recordActivity,
  ledger = null,
} = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '') || !isAddress(wallet || '')) {
    throw new Error('Invalid claim recovery hash or wallet');
  }
  const claimLedger = ledger || new Ledger(wallet, undefined,
    { fundingMode: 'creator-fees', requireExisting: true });
  const [chainId, transaction, receipt] = await Promise.all([
    client.getChainId(), client.getTransaction({ hash }), client.getTransactionReceipt({ hash }),
  ]);
  if (chainId !== CHAIN_ID || receipt.status !== 'success' ||
    !isAddressEqual(transaction.from, wallet) || !transaction.to ||
    !isAddressEqual(transaction.to, config.feeEscrow) ||
    receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error('Recovery transaction is not a confirmed agent claim on Robinhood Chain');
  }
  const decoded = decodeFunctionData({ abi: claimAbi, data: transaction.input });
  if (decoded.functionName !== 'claimToken' || !isAddressEqual(decoded.args[0], USDG)) {
    throw new Error('Recovery transaction did not claim USDG');
  }
  const claimed = transferAmount(receipt.logs, USDG, config.feeEscrow, wallet);
  if (claimed <= 0n) throw new Error('Recovery receipt has no escrow-to-wallet USDG transfer');
  const credited = claimLedger.state.claimHashes.some(value => value.toLowerCase() === hash.toLowerCase());
  const recorded = events(0).some(event => event.type === 'claim_confirmed' &&
    event.txHash?.toLowerCase() === hash.toLowerCase());
  if (recorded && !credited) throw new Error('Claim appears in activity but not the spending ledger');
  if (!credited) claimLedger.creditClaim(claimed, hash);
  if (!recorded) {
    record('claim_confirmed', 'Creator fees claimed',
      formatUnits(claimed, 6) + ' USDG transferred from the Pons escrow and verified onchain after an interrupted confirmation.',
      { amountUsdg: formatUnits(claimed, 6), txHash: hash });
  }
  return credited && recorded ? null : { claimed: formatUnits(claimed, 6), txHash: hash };
}

export async function recoverConfirmedSwap(hash, wallet, {
  client = publicClient, events = activityAfter, record = recordActivity, verifyRoute = verifyPool,
} = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '') || !isAddress(wallet || '')) {
    throw new Error('Invalid swap recovery hash or wallet');
  }
  if (events(0).some(event => event.type === 'buy_confirmed' && event.txHash?.toLowerCase() === hash.toLowerCase())) {
    return null;
  }
  const [chainId, transaction, receipt] = await Promise.all([
    client.getChainId(), client.getTransaction({ hash }), client.getTransactionReceipt({ hash }),
  ]);
  if (chainId !== CHAIN_ID || receipt.status !== 'success' ||
    !isAddressEqual(transaction.from, wallet) || !transaction.to ||
    !isAddressEqual(transaction.to, V3_ROUTER) || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error('Recovery transaction is not a confirmed agent swap on Robinhood Chain');
  }
  const decoded = decodeFunctionData({ abi: routerAbi, data: transaction.input });
  if (decoded.functionName !== 'exactInputSingle') throw new Error('Recovery transaction used an unexpected router call');
  const swap = decoded.args[0];
  const routeEntry = Object.entries(POOLS).find(([, route]) => isAddressEqual(route.token, swap.tokenOut));
  if (!routeEntry) throw new Error('Recovery swap did not purchase an approved Stock Token');
  const [ticker, route] = routeEntry;
  if (!isAddressEqual(swap.tokenIn, USDG) || !isAddressEqual(swap.recipient, wallet) ||
    swap.fee !== route.fee || swap.amountIn <= 0n || swap.amountOutMinimum <= 0n ||
    swap.sqrtPriceLimitX96 !== 0n) throw new Error('Recovery swap parameters do not match the approved route');
  await verifyRoute(ticker, client);
  const usdSpent = transferAmount(receipt.logs, USDG, wallet, route.pool);
  const stockReceived = transferAmount(receipt.logs, route.token, route.pool, wallet);
  if (usdSpent !== swap.amountIn || stockReceived < swap.amountOutMinimum) {
    throw new Error('Recovery receipt lacks the expected USDG payment or Stock Token delivery');
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const blockMs = Number(block.timestamp) * 1000;
  const amountUsdg = formatUnits(usdSpent, 6);
  const reservation = events(0).filter(event => event.type === 'trade_reserved' &&
    event.ticker === ticker && event.amountUsdg === amountUsdg &&
    Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) >= blockMs - 120_000 &&
    Date.parse(event.at) <= blockMs + 5_000).at(-1);
  if (!reservation) throw new Error('Recovery swap has no matching persisted trade reservation');
  record('buy_confirmed', ticker + ' Stock Tokens bought',
    `Recovered a confirmed swap after deployment interruption: ${amountUsdg} USDG paid to the approved pool and ${formatUnits(stockReceived, 18)} Stock Tokens delivered onchain.`,
    { ticker, amountUsdg, txHash: hash });
  return { ticker, amountUsdg, stockReceived: formatUnits(stockReceived, 18), txHash: hash };
}
