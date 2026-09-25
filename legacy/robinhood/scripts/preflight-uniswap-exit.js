// Read-only live integration check. Never signs, approves, or submits an order.
import { hashTypedData, parseUnits } from 'viem';
import { CHAIN_ID, USDG } from '../src/config.js';
import { validateUniswapXQuote } from '../src/exit-policy.js';

const apiKey = process.env.UNISWAP_API_KEY || process.env.UNISWA_API_KEY;
if (!apiKey) throw new Error('Uniswap API key missing');

const statusResponse = await fetch('https://agent-production-02cc.up.railway.app/status.json', {
  signal: AbortSignal.timeout(15_000),
});
if (!statusResponse.ok) throw new Error(`Public status HTTP ${statusResponse.status}`);
const status = await statusResponse.json();
if (status.chainId !== CHAIN_ID || !status.creatorWallet) throw new Error('Unexpected public agent identity');

for (const position of status.portfolio?.stocks || []) {
  if (!['NVDA', 'AAPL'].includes(position.ticker)) continue;
  const quoteResponse = await fetch('https://trade-api.gateway.uniswap.org/v1/quote', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-universal-router-version': '2.1.1',
    },
    body: JSON.stringify({
      type: 'EXACT_INPUT',
      amount: parseUnits(position.quantity, 18).toString(),
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      tokenIn: position.token,
      tokenOut: USDG,
      swapper: status.creatorWallet,
      permitAmount: 'EXACT',
      slippageTolerance: 0.5,
      routingPreference: 'BEST_PRICE',
      protocols: ['UNISWAPX_V3'],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await quoteResponse.json();
  const output = result.quote?.orderInfo?.outputs?.[0];
  let validation;
  try {
    const checked = validateUniswapXQuote(result, {
      ticker: position.ticker, wallet: status.creatorWallet,
      amount: parseUnits(position.quantity, 18), minimumUsdg: 1n,
    });
    hashTypedData({
      domain: result.permitData.domain, types: result.permitData.types,
      primaryType: 'PermitWitnessTransferFrom', message: result.permitData.values,
    });
    validation = { ok: true, typedDataEncodes: true, worstCaseUsdg: Number(checked.floorUsdg) / 1e6 };
  } catch (error) { validation = { ok: false, reason: error.message }; }
  console.log(JSON.stringify({
    ticker: position.ticker,
    httpStatus: quoteResponse.status,
    errorCode: result.errorCode || null,
    routing: result.routing || null,
    startingUsdg: output ? Number(output.startAmount) / 1e6 : null,
    validation,
  }));
}
