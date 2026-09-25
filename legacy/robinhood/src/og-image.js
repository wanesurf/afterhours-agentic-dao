import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const background = readFileSync(new URL('../public/og-afterhours.png', import.meta.url));
const money = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
export function ogTreasurySnapshot(portfolio) {
  const raw = portfolio?.estimatedTreasuryUsdg;
  const checkedMs = Date.parse(portfolio?.checkedAt || '');
  const complete = portfolio?.treasuryValuationComplete === true &&
    typeof raw === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw) &&
    Number.isFinite(Number(raw)) && Number.isFinite(checkedMs);
  if (!complete) return { version: 'unavailable', amount: null };
  return {
    version: String(checkedMs),
    amount: money.format(Number(raw)),
  };
}

export async function renderTreasuryOg(snapshot) {
  const amount = snapshot.amount || 'Unavailable';
  const amountSize = amount.length > 15 ? 40 : amount.length > 12 ? 48 : 58;
  // Only internally formatted numeric and date strings enter this SVG.
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <defs>
      <linearGradient id="fade"><stop offset="0" stop-color="#010102"/><stop offset="0.84" stop-color="#010102"/><stop offset="1" stop-color="#010102" stop-opacity="0"/></linearGradient>
    </defs>
    <rect x="0" y="451" width="670" height="179" fill="url(#fade)"/>
    <text x="68" y="508" fill="#f7f7f6" font-family="DejaVu Sans, sans-serif" font-size="21">Treasury value</text>
    <text x="65" y="577" fill="${snapshot.amount ? '#58e849' : '#a7aaa8'}" font-family="DejaVu Sans, sans-serif" font-size="${amountSize}" font-weight="300">${amount}</text>
  </svg>`);
  return sharp(background).composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer();
}
