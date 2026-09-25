import { isAddress, isAddressEqual } from 'viem';

const API = 'https://api.dexscreener.com';
const SITE = 'https://agent-production-02cc.up.railway.app/';

const sameUrl = (left, right) => {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.protocol === 'https:' && a.origin === b.origin &&
      a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch { return false; }
};

function agentSocial(social, handle) {
  if (!['twitter', 'x'].includes(String(social?.platform || social?.type || '').toLowerCase())) return false;
  const value = String(social.handle || social.url || '').trim();
  if (value.replace(/^@/, '').toLowerCase() === handle.toLowerCase()) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname) &&
      url.pathname.replace(/^\//, '').replace(/\/$/, '').toLowerCase() === handle.toLowerCase();
  } catch { return false; }
}

async function readJson(request, path) {
  const response = await request(API + path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200) throw new Error('DEX Screener HTTP ' + response.status);
  return response.json();
}

// An unpaid order or an approved order whose public profile has not propagated is not ready.
export async function liveDexProfile({ token, handle, request = fetch, approvedOrderId = '' }) {
  if (!isAddress(token || '') || !/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) {
    throw new Error('DEX Screener profile watch requires a token address and X handle');
  }
  if (approvedOrderId && !/^\d{8,20}$/.test(approvedOrderId)) {
    throw new Error('Invalid DEX Screener approved order ID');
  }
  const path = '/robinhood/' + token;
  if (!approvedOrderId) {
    const ordersBody = await readJson(request, '/orders/v1' + path);
    const orders = Array.isArray(ordersBody) ? ordersBody : ordersBody?.orders;
    if (!Array.isArray(orders)) throw new Error('DEX Screener orders response is invalid');
    const approved = orders.some(order => order?.type === 'tokenProfile' && order.status === 'approved' &&
      Number(order.paymentTimestamp) > 0);
    if (!approved) return null;
  }

  const pairs = await readJson(request, '/token-pairs/v1' + path);
  if (!Array.isArray(pairs)) throw new Error('DEX Screener pairs response is invalid');
  const matches = pairs.filter(pair => pair?.chainId === 'robinhood' &&
    isAddress(pair.baseToken?.address || '') && isAddressEqual(pair.baseToken.address, token) &&
    pair.info?.websites?.some(site => sameUrl(site.url, SITE)) &&
    pair.info?.socials?.some(social => agentSocial(social, handle)) &&
    typeof pair.info.imageUrl === 'string' && pair.info.imageUrl.startsWith('https://'));
  matches.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
  for (const pair of matches) {
    try {
      const url = new URL(pair.url);
      if (url.protocol === 'https:' && url.hostname === 'dexscreener.com' &&
        /^\/robinhood\/0x[0-9a-fA-F]{64}$/.test(url.pathname)) return url.toString();
    } catch { /* Ignore malformed links in the public API. */ }
  }
  return null;
}
