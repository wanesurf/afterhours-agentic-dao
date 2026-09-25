// Read-only chain reconstruction of held acquisition quantities and USDG paid.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnits } from 'viem';
import { scanAcquisitions } from '../src/exit-basis.js';

const response = await fetch('https://agent-production-02cc.up.railway.app/status.json', {
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Public status HTTP ${response.status}`);
const status = await response.json();
const path = join(mkdtempSync(join(tmpdir(), 'afterhours-exit-basis-')), 'basis.json');
const started = Date.now();
const basis = await scanAcquisitions(status.creatorWallet, { path });
const rows = Object.fromEntries(status.portfolio.stocks.map(stock => {
  const acquired = BigInt(basis[stock.ticker].quantity);
  return [stock.ticker, {
    acquiredUsdg: Number(basis[stock.ticker].spentUsdg) / 1e6,
    matchesHeldQuantity: acquired === parseUnits(stock.quantity, 18),
  }];
}));
console.log(JSON.stringify({ throughBlock: basis.throughBlock, seconds: (Date.now() - started) / 1000, rows }));
