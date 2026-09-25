import { isAddressEqual } from 'viem';
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { CHAIN_ID, config, USDG } from './config.js';

const request = (url) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });

export async function fetchBoard() {
  const res = await request(`${config.oracleUrl}/api/board`);
  if (!res.ok) throw new Error(`Oracle board returned HTTP ${res.status}`);
  if (res.url !== `${config.oracleUrl}/api/board`) throw new Error('Board URL changed unexpectedly');
  const board = await res.json();
  if (board.network !== `eip155:${CHAIN_ID}` || !board.treasury || !isAddressEqual(board.treasury, config.oraclePayTo)) {
    throw new Error('Oracle board network or payment recipient changed');
  }
  return board;
}

export function parsePriceChallenge(header, recipient = config.oraclePayTo, maxFee = config.maxApiFee) {
  if (!header) throw new Error('Oracle did not send an x402 payment challenge');
  let challenge;
  try { challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch { throw new Error('Invalid oracle payment challenge'); }
  if (challenge.x402Version !== 2 || !Array.isArray(challenge.accepts)) throw new Error('Unsupported x402 challenge');
  const options = challenge.accepts.filter(a => a.scheme === 'exact' && a.network === `eip155:${CHAIN_ID}` &&
    a.asset && isAddressEqual(a.asset, USDG) && a.payTo && isAddressEqual(a.payTo, recipient) && /^\d+$/.test(a.amount ?? ''));
  if (options.length !== 1) throw new Error('Oracle USDG payment terms missing or ambiguous');
  const fee = BigInt(options[0].amount);
  if (fee <= 0n || fee > maxFee) throw new Error('Oracle price exceeds MAX_API_FEE_USDG');
  return fee;
}

export function guardedOracleFetch(url, reservedFee, fetcher = fetch) {
  return async (input, init) => {
    const response = await fetcher(input, { ...init, redirect: 'error' });
    if (response.url !== url) throw new Error('Oracle payment fetch changed URL');
    if (response.status === 402 && parsePriceChallenge(response.headers.get('payment-required')) !== reservedFee) {
      throw new Error('Oracle payment terms changed after fee reservation');
    }
    return response;
  };
}

export function oracleSpendControls(maxFee = config.maxApiFee) {
  return {
    allowedAssets: [{
      network: `eip155:${CHAIN_ID}`,
      asset: USDG,
      maxAmountPerPayment: maxFee.toString(),
    }],
  };
}

export async function buySignal(ticker, signer, ledger, walletUsdg) {
  const url = `${config.oracleUrl}/price/${ticker}`;
  const challenge = await request(url);
  if (challenge.status !== 402) throw new Error(`Expected HTTP 402 for oracle ${ticker}, got ${challenge.status}`);
  if (challenge.url !== url) throw new Error('Oracle challenge URL changed unexpectedly');
  const fee = parsePriceChallenge(challenge.headers.get('payment-required'));
  ledger.reserve('api', null, fee, config.maxApiDaily, null, walletUsdg);

  const client = new x402Client()
    .register(`eip155:${CHAIN_ID}`, new ExactEvmScheme(signer.account))
    .setSpendControls(oracleSpendControls());
  // The x402 wrapper fetches a NEW 402. Validate that challenge too, so a
  // changed price or recipient between preflight and signature cannot spend more.
  const payFetch = wrapFetchWithPayment(guardedOracleFetch(url, fee), client);
  const paid = await payFetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!paid.ok || paid.url !== url) throw new Error(`Paid oracle returned HTTP ${paid.status} at ${paid.url}`);
  const responseHeader = paid.headers.get('payment-response') || paid.headers.get('x-payment-response');
  if (!responseHeader) throw new Error('Paid oracle response lacks settlement proof');
  const receipt = decodePaymentResponseHeader(responseHeader);
  if (receipt.network !== `eip155:${CHAIN_ID}` || !/^0x[0-9a-fA-F]{64}$/.test(receipt.transaction || '')) {
    throw new Error('Oracle payment receipt missing Robinhood Chain transaction');
  }
  return { signal: await paid.json(), fee, paymentTx: receipt.transaction };
}
