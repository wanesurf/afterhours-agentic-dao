import { isAddressEqual } from 'viem';
import { isDeepStrictEqual } from 'node:util';
import { CHAIN_ID, USDG } from './config.js';
import { POOLS } from './v3.js';

// Uniswap's Robinhood Chain Dutch V3 reactor and Permit2 deployments.
export const UNISWAPX_REACTOR = '0x000000007A1C8e570011EeDF86A2A35593013cBA';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export function inOpeningWindow(board, minutes, now = Date.now()) {
  if (board?.nyseOpenNow !== true || !Number.isFinite(Date.parse(board.asOf)) ||
      Math.abs(now - Date.parse(board.asOf)) > 45_000) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  const sinceOpen = hour * 60 + minute - 9 * 60 - 30;
  return sinceOpen >= 0 && sinceOpen < minutes;
}

const positiveAtomic = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? BigInt(value) : null;
const addressIs = (a, b) => typeof a === 'string' && isAddressEqual(a, b);

function signedPartMatchesQuote(signed, shown) {
  // The API renders a one-step curve as an array in orderInfo, but packs its
  // relative block into a uint256 for the EIP-712 witness. Refuse unfamiliar
  // multi-step encodings until they can be checked without ambiguity.
  if (!signed || !shown || !Array.isArray(shown.curve?.relativeBlocks) ||
      shown.curve.relativeBlocks.length !== 1 ||
      !Number.isSafeInteger(shown.curve.relativeBlocks[0]) ||
      shown.curve.relativeBlocks[0] < 0 ||
      String(signed.curve?.relativeBlocks) !== String(shown.curve.relativeBlocks[0])) return false;
  const normalized = { ...shown, curve: {
    relativeBlocks: String(shown.curve.relativeBlocks[0]),
    relativeAmounts: shown.curve.relativeAmounts,
  } };
  return isDeepStrictEqual(signed, normalized);
}

export function portfolioExitMinimum(benchmarkStockValue, realizedSales, otherStockValue, improvement) {
  if ([benchmarkStockValue, realizedSales, otherStockValue, improvement]
      .some(value => typeof value !== 'bigint' || value < 0n)) {
    throw new Error('Incomplete treasury-value comparison');
  }
  const required = benchmarkStockValue + improvement - realizedSales - otherStockValue;
  return required > 0n ? required : 1n;
}

export function validateUniswapXQuote(response, { ticker, wallet, amount, minimumUsdg, now = Date.now() }) {
  const route = POOLS[ticker];
  if (!route || response?.routing !== 'DUTCH_V3') throw new Error('UniswapX V3 route unavailable');
  const info = response.quote?.orderInfo;
  if (Number(info?.chainId) !== CHAIN_ID || !addressIs(info.reactor, UNISWAPX_REACTOR) ||
      !addressIs(info.swapper, wallet) || !Number.isSafeInteger(Number(info.deadline)) ||
      Number(info.deadline) * 1000 <= now + 10_000) throw new Error('UniswapX order identity or deadline invalid');
  if (!addressIs(info.input?.token, route.token) ||
      positiveAtomic(info.input?.startAmount) !== amount ||
      positiveAtomic(info.input?.maxAmount) !== amount) throw new Error('UniswapX input differs from the held position');
  if (!Array.isArray(info.outputs) || info.outputs.length !== 1 ||
      !addressIs(info.outputs[0]?.token, USDG) || !addressIs(info.outputs[0]?.recipient, wallet)) {
    throw new Error('UniswapX output must be USDG to the agent wallet only');
  }
  const start = positiveAtomic(info.outputs[0].startAmount);
  const end = positiveAtomic(info.outputs[0].minAmount);
  if (!start || !end || start < end || end < minimumUsdg) {
    throw new Error('UniswapX worst-case USDG output is below the treasury target');
  }
  if (!/^0x[0-9a-fA-F]+$/.test(response.quote?.encodedOrder || '') ||
      !/^0x[0-9a-fA-F]{64}$/.test(response.quote?.orderId || '')) {
    throw new Error('UniswapX quote lacks an encoded order or stable order ID');
  }
  const permit = response.permitData;
  if (!permit || Number(permit.domain?.chainId) !== CHAIN_ID || !addressIs(permit.domain?.verifyingContract, PERMIT2)) {
    throw new Error('Permit2 signing domain is not Robinhood Chain Permit2');
  }
  const permitted = permit.values?.permitted;
  if (!permitted || Array.isArray(permitted) || !addressIs(permitted.token, route.token) ||
      positiveAtomic(String(permitted.amount)) !== amount ||
      !addressIs(permit.values?.spender, UNISWAPX_REACTOR) ||
      !Number.isSafeInteger(Number(permit.values?.deadline)) ||
      Number(permit.values.deadline) * 1000 <= now) {
    throw new Error('Permit2 signature would authorize an unexpected token, amount, or spender');
  }
  const witness = permit.values?.witness;
  const witnessInfo = witness?.info;
  if (!witnessInfo || !addressIs(witnessInfo.reactor, info.reactor) ||
      !addressIs(witnessInfo.swapper, info.swapper) ||
      String(witnessInfo.nonce) !== String(info.nonce) ||
      String(witnessInfo.deadline) !== String(info.deadline) ||
      !addressIs(witnessInfo.additionalValidationContract, info.additionalValidationContract) ||
      witnessInfo.additionalValidationData !== info.additionalValidationData ||
      !addressIs(witness.cosigner, info.cosigner) ||
      String(witness.startingBaseFee) !== String(info.startingBaseFee) ||
      !signedPartMatchesQuote(witness.baseInput, info.input) ||
      !Array.isArray(witness.baseOutputs) || witness.baseOutputs.length !== 1 ||
      !signedPartMatchesQuote(witness.baseOutputs[0], info.outputs[0]) ||
      String(permit.values.nonce) !== String(info.nonce)) {
    throw new Error('Permit2 witness differs from the profitable quoted order');
  }
  return { orderId: response.quote.orderId, startUsdg: start, floorUsdg: end };
}

export function formatExitUsdg(amount) {
  return (Number(amount) / 1_000_000).toFixed(2);
}
