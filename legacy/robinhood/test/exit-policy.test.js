import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';
import { USDG } from '../src/config.js';
import { POOLS } from '../src/v3.js';
import { inOpeningWindow, PERMIT2, portfolioExitMinimum,
  UNISWAPX_REACTOR, validateUniswapXQuote } from '../src/exit-policy.js';

const wallet = '0x141B4102b22457D397EBeB69fa6ea052F604C9b1';
const amount = parseUnits('5.39615884', 18);
const opening = Date.parse('2026-09-21T13:30:05Z');
const board = { nyseOpenNow: true, asOf: new Date(opening).toISOString() };

function quote() {
  const orderInfo = {
    chainId: 4663, reactor: UNISWAPX_REACTOR, swapper: wallet,
    nonce: '123', deadline: Math.floor(opening / 1000) + 120,
    additionalValidationContract: '0x0000000000000000000000000000000000000000',
    additionalValidationData: '0x',
    cosigner: '0x1111111111111111111111111111111111111111',
    startingBaseFee: '1',
    input: { token: POOLS.AAPL.token, startAmount: amount.toString(), maxAmount: amount.toString(),
      adjustmentPerGweiBaseFee: '0', curve: { relativeBlocks: [80], relativeAmounts: ['0'] } },
    outputs: [{ token: USDG, recipient: wallet, startAmount: '1900000000', minAmount: '1850000000',
      adjustmentPerGweiBaseFee: '0', curve: { relativeBlocks: [80], relativeAmounts: ['50000000'] } }],
  };
  const signedPart = part => ({ ...part,
    curve: { ...part.curve, relativeBlocks: String(part.curve.relativeBlocks[0]) } });
  return {
    routing: 'DUTCH_V3',
    quote: {
      orderId: '0x' + 'a'.repeat(64), encodedOrder: '0xabcd',
      orderInfo,
    },
    permitData: {
      domain: { chainId: 4663, verifyingContract: PERMIT2 },
      values: { permitted: { token: POOLS.AAPL.token, amount: amount.toString() },
        spender: UNISWAPX_REACTOR, nonce: orderInfo.nonce,
        deadline: String(Math.floor(opening / 1000) + 120),
        witness: { info: Object.fromEntries(['reactor', 'swapper', 'nonce', 'deadline',
          'additionalValidationContract', 'additionalValidationData'].map(key => [key, orderInfo[key]])),
        cosigner: orderInfo.cosigner, startingBaseFee: orderInfo.startingBaseFee,
        baseInput: signedPart(orderInfo.input), baseOutputs: [signedPart(orderInfo.outputs[0])] } },
    },
  };
}

test('exit can begin only on a fresh NYSE-open board during the opening window', () => {
  assert.equal(inOpeningWindow(board, 60, opening), true);
  assert.equal(inOpeningWindow({ ...board, nyseOpenNow: false }, 60, opening), false);
  assert.equal(inOpeningWindow({ ...board, asOf: new Date(opening - 60_000).toISOString() }, 60, opening), false);
  assert.equal(inOpeningWindow({ ...board, asOf: new Date(opening + 60 * 60_000).toISOString() }, 60, opening + 60 * 60_000), false);
});

test('treasury target counts only stock value and prior realized exits, excluding existing cash', () => {
  const stockValue = parseUnits('3330', 6); // $3510 total less $180 existing cash.
  assert.equal(portfolioExitMinimum(stockValue, 0n, parseUnits('1530', 6),
    parseUnits('1', 6)), parseUnits('1801', 6));
  assert.equal(portfolioExitMinimum(stockValue, parseUnits('1600', 6), 0n,
    parseUnits('1', 6)), parseUnits('1731', 6));
});

test('signed UniswapX order requires exact stock input, wallet USDG output, and profitable worst-case payout', () => {
  assert.equal(validateUniswapXQuote(quote(), { ticker: 'AAPL', wallet, amount,
    minimumUsdg: parseUnits('1849', 6), now: opening }).floorUsdg, parseUnits('1850', 6));
  const low = quote();
  low.quote.orderInfo.outputs[0].minAmount = parseUnits('1848', 6).toString();
  assert.throws(() => validateUniswapXQuote(low, { ticker: 'AAPL', wallet, amount,
    minimumUsdg: parseUnits('1849', 6), now: opening }), /treasury target/);
  const wrongRecipient = quote();
  wrongRecipient.quote.orderInfo.outputs[0].recipient = '0x1111111111111111111111111111111111111111';
  assert.throws(() => validateUniswapXQuote(wrongRecipient, { ticker: 'AAPL', wallet, amount,
    minimumUsdg: 0n, now: opening }), /agent wallet/);
  const wrongPermit = quote();
  wrongPermit.permitData.values.permitted.amount = (amount + 1n).toString();
  assert.throws(() => validateUniswapXQuote(wrongPermit, { ticker: 'AAPL', wallet, amount,
    minimumUsdg: 0n, now: opening }), /unexpected token, amount, or spender/);
  const wrongWitness = quote();
  wrongWitness.permitData.values.witness.baseOutputs[0].minAmount = '1';
  assert.throws(() => validateUniswapXQuote(wrongWitness, { ticker: 'AAPL', wallet, amount,
    minimumUsdg: 0n, now: opening }), /witness differs/);
});
