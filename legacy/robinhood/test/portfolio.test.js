import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';
import { AFTERHOURS, USDG } from '../src/config.js';
import { POOLS } from '../src/v3.js';
import { readPortfolio } from '../src/portfolio.js';

const wallet = '0x1111111111111111111111111111111111111111';
const client = {
  getChainId: async () => 4663,
  getBalance: async () => parseUnits('0.002', 18),
  readContract: async ({ address, args }) => {
    assert.equal(args[0], wallet);
    if (address.toLowerCase() === USDG.toLowerCase()) return parseUnits('94.737739', 6);
    if (address.toLowerCase() === AFTERHOURS.toLowerCase()) return 0n;
    if (address.toLowerCase() === POOLS.NVDA.token.toLowerCase()) return parseUnits('0.022627191892361135', 18);
    if (address.toLowerCase() === POOLS.AAPL.token.toLowerCase()) return 0n;
    throw new Error('Unexpected token');
  },
};

test('portfolio sums onchain cash and whole-position sell quotes exactly', async () => {
  const portfolio = await readPortfolio(wallet, { client, quote: async (ticker, quantity) => {
    assert.equal(ticker, 'NVDA');
    assert.equal(quantity, parseUnits('0.022627191892361135', 18));
    return parseUnits('4.98', 6);
  } });
  assert.equal(portfolio.cashUsdg, '94.737739');
  assert.equal(portfolio.stocks.find(stock => stock.ticker === 'NVDA').quantity, '0.022627191892361135');
  assert.equal(portfolio.stocks.find(stock => stock.ticker === 'NVDA').estimatedSellUsdg, '4.98');
  assert.equal(portfolio.stocks.find(stock => stock.ticker === 'AAPL').estimatedSellUsdg, '0');
  assert.equal(portfolio.estimatedTotalUsdg, '99.717739');
  assert.equal(portfolio.estimatedTreasuryUsdg, '99.717739');
  assert.equal(portfolio.valuationComplete, true);
  assert.equal(portfolio.treasuryValuationComplete, true);
});

test('portfolio retains token quantities when a sell quote is unavailable', async () => {
  const portfolio = await readPortfolio(wallet, { client, quote: async () => { throw new Error('Pool unavailable'); } });
  assert.equal(portfolio.stocks.find(stock => stock.ticker === 'NVDA').quantity, '0.022627191892361135');
  assert.equal(portfolio.stocks.find(stock => stock.ticker === 'NVDA').estimatedSellUsdg, null);
  assert.equal(portfolio.estimatedTotalUsdg, null);
  assert.equal(portfolio.estimatedTreasuryUsdg, null);
  assert.equal(portfolio.valuationComplete, false);
});

test('treasury includes the actual $AFTERHOURS balance at its whole-balance sell quote', async () => {
  const withToken = { ...client, readContract: async request =>
    request.address.toLowerCase() === AFTERHOURS.toLowerCase()
      ? parseUnits('15066199.969563232384720742', 18)
      : client.readContract(request) };
  const stockQuote = async () => parseUnits('4.98', 6);
  const tokenQuote = async (quantity) => {
    assert.equal(quantity, parseUnits('15066199.969563232384720742', 18));
    return parseUnits('459.359326', 6);
  };
  const portfolio = await readPortfolio(wallet, { client: withToken, quote: stockQuote, quoteAfterhours: tokenQuote });
  assert.equal(portfolio.afterhours.quantity, '15066199.969563232384720742');
  assert.equal(portfolio.afterhours.estimatedSellUsdg, '459.359326');
  assert.equal(portfolio.estimatedTotalUsdg, '99.717739');
  assert.equal(portfolio.estimatedTreasuryUsdg, '559.077065');
  assert.equal(portfolio.treasuryValuationComplete, true);

  const unquoted = await readPortfolio(wallet, { client: withToken, quote: stockQuote,
    quoteAfterhours: async () => { throw new Error('Pool quote unavailable'); } });
  assert.equal(unquoted.afterhours.quantity, portfolio.afterhours.quantity);
  assert.equal(unquoted.afterhours.estimatedSellUsdg, null);
  assert.equal(unquoted.estimatedTreasuryUsdg, null);
  assert.equal(unquoted.estimatedTotalUsdg, '99.717739');
});
