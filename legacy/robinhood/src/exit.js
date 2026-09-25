import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodeEventLog, formatUnits, isAddressEqual, parseAbi, parseAbiItem } from 'viem';
import { CHAIN_ID, USDG, WATCHLIST, config } from './config.js';
import { publicClient, ensureGas } from './chain.js';
import { scanAcquisitions } from './exit-basis.js';
import { loadOrCaptureExitBenchmark } from './exit-benchmark.js';
import { formatExitUsdg, inOpeningWindow, PERMIT2,
  portfolioExitMinimum, validateUniswapXQuote } from './exit-policy.js';
import { POOLS, quoteStockToUsdg } from './v3.js';
import { recordActivity, recordedExitCosts, recordedPortfolio } from './status.js';

const apiRoot = 'https://trade-api.gateway.uniswap.org/v1';
const statePath = resolve('.data/exit-orders.json');
const erc20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

function loadOrders(wallet, path = statePath) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    value = { version: 1, wallet,
      AAPL: { soldQuantity: '0', soldCostUsdg: '0', pending: null, history: [] },
      NVDA: { soldQuantity: '0', soldCostUsdg: '0', pending: null, history: [] } };
    saveOrders(value, path);
  }
  if (value.version !== 1 || !isAddressEqual(value.wallet, wallet) || WATCHLIST.some(ticker =>
    !/^\d+$/.test(value[ticker]?.soldQuantity || '') ||
    !/^\d+$/.test(value[ticker]?.soldCostUsdg || '') ||
    !Array.isArray(value[ticker]?.history))) {
    throw new Error('Exit order ledger is invalid or belongs to another wallet');
  }
  return value;
}

function saveOrders(value, path = statePath) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

async function api(method, endpoint, body = null) {
  const url = new URL(endpoint, apiRoot);
  if (url.origin !== new URL(apiRoot).origin || !url.pathname.startsWith('/v1/')) throw new Error('Invalid Uniswap API path');
  const response = await fetch(url, {
    method,
    headers: {
      'x-api-key': config.uniswapApiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-universal-router-version': '2.1.1',
      'x-agent-info': JSON.stringify({ decision_origin: 'autonomous', integration_name: 'Afterhours Agent', version: '1' }),
    },
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Uniswap API ${url.pathname} returned invalid JSON (${response.status})`); }
  if (!response.ok) throw new Error(`Uniswap API ${url.pathname} rejected request (${response.status}: ${result.errorCode || result.error || 'unknown'})`);
  return result;
}

async function checkPermit2Allowance(identity, ticker, amount, client = publicClient) {
  const token = POOLS[ticker].token;
  const allowance = await client.readContract({ address: token, abi: erc20, functionName: 'allowance',
    args: [identity.account.address, PERMIT2] });
  if (allowance >= amount) return false;
  ensureGas(await client.getBalance({ address: identity.account.address }));
  const { request } = await client.simulateContract({ address: token, abi: erc20,
    functionName: 'approve', args: [PERMIT2, amount], account: identity.account });
  const hash = await identity.wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Permit2 token approval reverted: ${hash}`);
  recordActivity('exit_approval_confirmed', `${ticker} exact Permit2 allowance confirmed`,
    `Approved only ${formatUnits(amount, 18)} Stock Tokens for Permit2.`, { ticker, txHash: hash });
  return true;
}

export function actualFill(receipt, pending, ticker, wallet, settlement) {
  if (receipt.status !== 'success') throw new Error(`${ticker} UniswapX fill transaction reverted`);
  if (!settlement || !isAddressEqual(settlement.tokenIn, POOLS[ticker].token) ||
      !isAddressEqual(settlement.tokenOut, USDG) ||
      !/^\d+$/.test(settlement.amountIn || '') || !/^\d+$/.test(settlement.amountOut || '') ||
      BigInt(settlement.amountIn) !== BigInt(pending.amount) ||
      BigInt(settlement.amountOut) < BigInt(pending.floorUsdg)) {
    throw new Error(`${ticker} UniswapX order settlement is below its signed treasury target`);
  }
  let spent = 0n;
  let received = 0n;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, POOLS[ticker].token) && !isAddressEqual(log.address, USDG)) continue;
    let event;
    try { event = decodeEventLog({ abi: [transfer], data: log.data, topics: log.topics }); }
    catch { continue; }
    if (isAddressEqual(log.address, POOLS[ticker].token) && isAddressEqual(event.args.from, wallet)) {
      spent += event.args.value;
    }
    if (isAddressEqual(log.address, USDG) && isAddressEqual(event.args.to, wallet)) {
      received += event.args.value;
    }
  }
  if (spent < BigInt(settlement.amountIn) || received < BigInt(settlement.amountOut)) {
    throw new Error(`${ticker} UniswapX fill does not match the committed stock input and USDG floor`);
  }
  return BigInt(settlement.amountOut);
}

function permitPrimaryType(types) {
  if (!types || typeof types !== 'object') throw new Error('Missing Permit2 typed data');
  const names = Object.keys(types).filter(name => name !== 'EIP712Domain');
  const referenced = new Set(Object.values(types).flatMap(fields =>
    Array.isArray(fields) ? fields.map(field => String(field.type).replace(/\[.*$/, '')) : []));
  const roots = names.filter(name => !referenced.has(name));
  if (roots.length !== 1) throw new Error('Unexpected Permit2 signing types');
  return roots[0];
}

async function reconcilePending(orders, ticker, wallet, client = publicClient) {
  const pending = orders[ticker].pending;
  if (!pending) return;
  const response = await api('GET', `/v1/orders?orderId=${encodeURIComponent(pending.orderId)}`);
  const order = response.orders?.find(item => item.orderId?.toLowerCase() === pending.orderId.toLowerCase());
  if (!order) return; // Unknown status is not permission to create another order.
  if (Number(order.chainId) !== CHAIN_ID || order.type !== 'Dutch_V3' ||
      !isAddressEqual(order.swapper, wallet)) throw new Error(`${ticker} UniswapX order identity changed`);
  const status = String(order.orderStatus || '').toLowerCase();
  if (status === 'open' || status === 'unverified') return;
  if (status === 'filled') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(order.txHash || '')) throw new Error('Filled order has no verifiable transaction');
    const receipt = await client.getTransactionReceipt({ hash: order.txHash });
    const latestBlock = await client.getBlockNumber();
    if (receipt.blockNumber === undefined || latestBlock < receipt.blockNumber + 12n) return 'awaiting_finality';
    if (!Array.isArray(order.settledAmounts) || order.settledAmounts.length !== 1) return 'awaiting_finality';
    const received = actualFill(receipt, pending, ticker, wallet, order.settledAmounts[0]);
    orders[ticker].soldQuantity = (BigInt(orders[ticker].soldQuantity) + BigInt(pending.amount)).toString();
    orders[ticker].soldCostUsdg = (BigInt(orders[ticker].soldCostUsdg) + BigInt(pending.acquisitionCostUsdg)).toString();
    orders[ticker].history.push({ ...pending, orderStatus: 'filled', txHash: order.txHash,
      receivedUsdg: received.toString(), filledAt: new Date().toISOString() });
    orders[ticker].pending = null;
    saveOrders(orders);
    recordActivity('exit_filled', `${ticker} Stock Tokens sold for USDG`,
      `${formatUnits(pending.amount, 18)} Stock Tokens sold for ${formatUnits(received, 6)} USDG. ` +
      `The order's worst-case output passed the locked pre-open treasury-value target.`,
      { ticker, amountUsdg: formatUnits(received, 6), txHash: order.txHash });
    return;
  }
  if (status === 'expired') {
    orders[ticker].history.push({ ...pending, orderStatus: 'expired' });
    orders[ticker].pending = null;
    saveOrders(orders);
    recordActivity('exit_expired', `${ticker} exit order expired`, 'No fill was confirmed; a later fresh quote may be considered.', { ticker });
    return;
  }
  // Error, cancellation, insufficient funds, and unknown states require review.
  throw new Error(`${ticker} UniswapX order ${pending.orderId} requires review (${status || 'unknown'})`);
}

export async function runExitCycle(board, identity, {
  client = publicClient, scan = scanAcquisitions, now = Date.now(),
  clock = Date.now, getBenchmark = loadOrCaptureExitBenchmark, quoteOther = quoteStockToUsdg,
} = {}) {
  if (!config.exitEnabled) return;
  const wallet = identity.account.address;
  const orders = loadOrders(wallet);
  let awaitingFinality = false;
  for (const ticker of WATCHLIST) {
    if (await reconcilePending(orders, ticker, wallet, client) === 'awaiting_finality') awaitingFinality = true;
  }
  if (awaitingFinality) return;
  // A submitted order may consume the wallet inventory at any moment. Finish
  // or expire it before pricing another sale against the same treasury value.
  if (WATCHLIST.some(ticker => orders[ticker].pending)) return;
  if (!inOpeningWindow(board, config.exitWindowMinutes, now)) return;

  const acquisitions = await scan(wallet, { client });
  if (!inOpeningWindow(board, config.exitWindowMinutes, clock())) return;
  const recorded = recordedExitCosts();
  const acquiredTotal = WATCHLIST.reduce((sum, ticker) => sum + BigInt(acquisitions[ticker].spentUsdg), 0n);
  if (acquiredTotal < recorded.acquiredUsdg) {
    throw new Error('Onchain acquisition spend is below the public confirmed-buy ledger; exits stopped');
  }
  const balances = Object.fromEntries(await Promise.all(WATCHLIST.map(async ticker => [ticker,
    await client.readContract({ address: POOLS[ticker].token, abi: erc20,
      functionName: 'balanceOf', args: [wallet] })])));
  const costs = {};
  for (const ticker of WATCHLIST) {
    const acquired = BigInt(acquisitions[ticker].quantity);
    const sold = BigInt(orders[ticker].soldQuantity);
    if (sold > acquired) throw new Error(`${ticker} recorded sales exceed verified acquisitions`);
    if (orders[ticker].pending && acquired - sold !== balances[ticker]) return;
    if (acquired - sold !== balances[ticker]) {
      throw new Error(`${ticker} wallet inventory differs from verified buys less confirmed UniswapX sales`);
    }
    costs[ticker] = BigInt(acquisitions[ticker].spentUsdg) - BigInt(orders[ticker].soldCostUsdg);
    if (costs[ticker] < 0n) throw new Error(`${ticker} recorded sale cost exceeds acquisition spend`);
  }
  const benchmark = getBenchmark(wallet, recordedPortfolio(), orders, now);
  for (const ticker of WATCHLIST) {
    if (BigInt(benchmark.positions[ticker].quantity) !==
        BigInt(acquisitions[ticker].quantity) - BigInt(benchmark.positions[ticker].soldAtCapture)) {
      throw new Error(`${ticker} holdings changed after the pre-open treasury benchmark`);
    }
  }
  const benchmarkStockValue = BigInt(benchmark.totalUsdg) - BigInt(benchmark.cashUsdg);
  const realizedSales = WATCHLIST.reduce((sum, ticker) => sum + orders[ticker].history
    .filter(entry => entry.orderStatus === 'filled' && entry.benchmarkDate === benchmark.date)
    .reduce((subtotal, entry) => subtotal + BigInt(entry.receivedUsdg), 0n), 0n);

  for (const ticker of WATCHLIST) {
    if (!balances[ticker] || orders[ticker].pending) continue;
    const otherValue = (await Promise.all(WATCHLIST.filter(other => other !== ticker && balances[other] > 0n)
      .map(other => quoteOther(other, balances[other], client))))
      .reduce((sum, value) => sum + value, 0n);
    const portfolioMinimum = portfolioExitMinimum(benchmarkStockValue, realizedSales,
      otherValue, config.exitMinProfitUsdg);
    const minimumUsdg = portfolioMinimum;
    const request = {
      type: 'EXACT_INPUT', amount: balances[ticker].toString(), tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID, tokenIn: POOLS[ticker].token, tokenOut: USDG,
      swapper: wallet, permitAmount: 'EXACT', slippageTolerance: 0.5,
      routingPreference: 'BEST_PRICE', protocols: ['UNISWAPX_V3'],
    };
    let quote = await api('POST', '/v1/quote', request);
    let approved;
    try { approved = validateUniswapXQuote(quote,
      { ticker, wallet, amount: balances[ticker], minimumUsdg }); }
    catch (error) {
      const rejectedMinimum = quote.quote?.orderInfo?.outputs?.[0]?.minAmount;
      const belowFloor = /treasury target/.test(error.message) &&
        typeof rejectedMinimum === 'string' && /^\d+$/.test(rejectedMinimum);
      recordActivity('exit_quote_rejected', `${ticker} exit quote rejected`,
        belowFloor
          ? `Worst-case UniswapX proceeds ${formatExitUsdg(BigInt(rejectedMinimum))} USDG are below the ` +
            `${formatExitUsdg(minimumUsdg)} USDG locked pre-open treasury-value target.`
          : `The UniswapX quote failed route, signing, or ${formatExitUsdg(minimumUsdg)} USDG minimum proceeds validation.`,
        { ticker });
      continue;
    }
    if (await checkPermit2Allowance(identity, ticker, balances[ticker], client)) {
      quote = await api('POST', '/v1/quote', request);
      approved = validateUniswapXQuote(quote,
        { ticker, wallet, amount: balances[ticker], minimumUsdg });
    }
    if (!inOpeningWindow(board, config.exitWindowMinutes, clock())) return;
    const signature = await identity.account.signTypedData({
      domain: quote.permitData.domain, types: quote.permitData.types,
      primaryType: permitPrimaryType(quote.permitData.types), message: quote.permitData.values,
    });
    // Persist before network submission. A timeout can never cause a duplicate order.
    const pending = { orderId: approved.orderId, amount: balances[ticker].toString(),
      acquisitionCostUsdg: costs[ticker].toString(), floorUsdg: approved.floorUsdg.toString(),
      minimumUsdg: minimumUsdg.toString(), portfolioMinimumUsdg: portfolioMinimum.toString(),
      benchmarkDate: benchmark.date, createdAt: new Date().toISOString() };
    orders[ticker].pending = pending;
    saveOrders(orders);
    const submitted = await api('POST', '/v1/order', {
      quote: quote.quote, routing: quote.routing, signature,
    });
    if (submitted.orderId?.toLowerCase() !== pending.orderId.toLowerCase()) {
      throw new Error(`${ticker} submitted UniswapX order ID differs from the signed quote`);
    }
    recordActivity('exit_order_submitted', `${ticker} UniswapX sell order submitted`,
      `Full position ${formatUnits(balances[ticker], 18)} Stock Tokens; worst-case payout ` +
      `${formatUnits(approved.floorUsdg, 6)} USDG exceeds the ${formatUnits(minimumUsdg, 6)} USDG ` +
      `locked treasury-value target. ` +
      `Awaiting an independently confirmed fill.`, { ticker });
    break;
  }
}
