import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('public dashboard records real events, serves bounded history, and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-status-'));
  const previous = process.cwd();
  const previousAddress = process.env.AGENT_PUBLIC_ADDRESS;
  const previousChat = process.env.WEB_CHAT_ENABLED;
  process.env.AGENT_PUBLIC_ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.WEB_CHAT_ENABLED = 'false';
  symlinkSync(resolve('public'), join(directory, 'public'), 'dir');
  process.chdir(directory);
  let server;
  try {
    const telemetry = await import('../src/status.js?test=first');
    const now = new Date().toISOString();
    telemetry.markCycleStarted();
    telemetry.recordBoard({ asOf: now, nyseOpenNow: false, pricePerQuoteUsdg: 0.05 }, [
      { ticker: 'AAPL', name: 'Apple', onchain: 95, close: 100, discount: 5, eligible: true, reasons: [] },
    ], ['AAPL']);
    telemetry.recordActivity('api_paid', 'AAPL quote paid', '0.05 USDG settled.', {
      ticker: 'AAPL', amountUsdg: '0.05', txHash: '0x' + 'a'.repeat(64),
    });
    telemetry.recordPortfolio({ wallet: process.env.AGENT_PUBLIC_ADDRESS, checkedAt: now,
      cashUsdg: '95', gasEth: '0.002', valuationComplete: true, estimatedTotalUsdg: '100',
      afterhours: { quantity: '1000', estimatedSellUsdg: '10' },
      treasuryValuationComplete: true, estimatedTreasuryUsdg: '110',
      stocks: [{ ticker: 'AAPL', quantity: '0.05', estimatedSellUsdg: '5' }] });
    telemetry.markCycleFinished(true);
    server = await telemetry.startStatusServer(0);
    const base = 'http://127.0.0.1:' + server.address().port;

    const response = await fetch(base + '/status.json');
    assert.equal(response.status, 200);
    const publicState = await response.json();
    assert.equal(publicState.status, 'healthy');
    assert.equal(publicState.mode, 'read-only');
    assert.equal(publicState.fundingMode, 'creator-fees');
    assert.equal(publicState.walletBudgetUsdg, null);
    assert.equal(publicState.social.enabled, false);
    assert.equal(publicState.social.automatedLabelConfirmed, false);
    assert.equal(publicState.social.accountHandle, null);
    assert.equal(publicState.totals.apiPaidUsdg, '0.05');
    assert.equal(publicState.board.rows[0].ticker, 'AAPL');
    assert.equal(publicState.portfolio.stocks[0].quantity, '0.05');
    assert.equal(publicState.portfolio.estimatedTotalUsdg, '100');
    assert.equal(publicState.portfolio.estimatedTreasuryUsdg, '110');
    assert.equal(publicState.activity.find(event => event.type === 'api_paid').txHash, '0x' + 'a'.repeat(64));
    assert.equal(JSON.stringify(publicState).includes('AGENT_PRIVATE_KEY'), false);

    const history = await (await fetch(base + '/history.json?ticker=AAPL&hours=24')).json();
    assert.equal(history.points.length, 1);
    assert.equal(history.points[0].price, 95);
    assert.equal((await fetch(base + '/history.json?ticker=FAKE')).status, 400);
    const activity = await (await fetch(base + '/activity.json?limit=1')).json();
    assert.equal(activity.events.length, 1);
    assert.equal(activity.hasMore, true);
    const pageResponse = await fetch(base + '/');
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /Holders set[\s\S]*the mandate/);
    assert.match(page, /market-open-countdown/);
    assert.match(page, /id="chat-question"/);
    assert.match(page, /\/app\.js\?v=\d+/);
    assert.match(page, /og-afterhours\.png\?v=4/);
    assert.doesNotMatch(page, /dashboard\.js|dao-ui\.js|market-clock\.js/);
    const ogResponse = await fetch(base + '/og-treasury.png');
    assert.equal(ogResponse.status, 200);
    assert.equal(ogResponse.headers.get('content-type'), 'image/png');
    const ogImage = Buffer.from(await ogResponse.arrayBuffer());
    assert.deepEqual([ogImage.readUInt32BE(16), ogImage.readUInt32BE(20)], [1200, 630]);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    assert.equal((await fetch(base + '/chat.json')).status, 405);
    const chatResponse = await fetch(base + '/chat.json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What is in the treasury?' }),
    });
    assert.equal(chatResponse.status, 503);
    assert.match((await chatResponse.json()).error, /not configured/);
    assert.equal((await fetch(base + '/decisions.html')).status, 200);
    assert.equal((await fetch(base + '/decisions.css')).status, 200);
    assert.equal((await fetch(base + '/decisions.js')).status, 200);
    assert.equal((await fetch(base + '/dashboard.js')).status, 404);
    assert.equal((await fetch(base + '/dao-ui.js')).status, 404);
    const daoConfigResponse = await fetch(base + '/dao-config.json');
    assert.equal(daoConfigResponse.status, 200);
    const daoConfig = await daoConfigResponse.json();
    assert.equal(daoConfig.network.chainId, 4663);
    assert.equal(daoConfig.governance.status, 'not-deployed');
    assert.equal(daoConfig.governance.deploymentBlock, null);
    assert.equal((await fetch(base + '/afterhours-robot.png')).status, 200);
    assert.equal((await fetch(base + '/dashboard.css')).status, 200);

    const missingBuys = await (await fetch(base + '/buys.json?ticker=AAPL')).json();
    assert.equal(missingBuys.available, false);
    assert.equal((await fetch(base + '/buys.json?ticker=FAKE')).status, 400);
    mkdirSync(join(directory, '.data'), { recursive: true });
    const buyPath = join(directory, '.data', 'buy-history.json');
    writeFileSync(buyPath, JSON.stringify({ version: 1, wallet: process.env.AGENT_PUBLIC_ADDRESS,
      throughBlock: 50, buys: [{ ticker: 'AAPL', txHash: '0x' + 'e'.repeat(64),
        blockNumber: 10, at: now, quantity: '25000000000000000', spentUsdg: '5000000' }] }));
    const indexedBuys = await (await fetch(base + '/buys.json?ticker=AAPL')).json();
    assert.equal(indexedBuys.available, true);
    assert.equal(indexedBuys.buys[0].quantity, '0.025');
    assert.equal(indexedBuys.buys[0].spentUsdg, '5');
    assert.equal((await fetch(base + '/buys.json?ticker=NVDA')).status, 200);
    rmSync(buyPath);

    const emptyExits = await (await fetch(base + '/exits.json')).json();
    assert.equal(emptyExits.count, 0);
    assert.deepEqual(emptyExits.sales, []);
    const emptyBuybacks = await (await fetch(base + '/buybacks.json')).json();
    assert.equal(emptyBuybacks.count, 0);
    const buybackPath = join(directory, '.data', 'buyback.json');
    writeFileSync(buybackPath, JSON.stringify({ version: 1,
      wallet: process.env.AGENT_PUBLIC_ADDRESS, spentUsdg: '10000000',
      token: '0x6918EcC39996DAE959FBb7aAb1F6e926f285eBd4',
      burned: '500000000000000000000', history: [{ at: now,
        spentUsdg: '10000000', burned: '500000000000000000000',
        swapTxHash: '0x' + 'f'.repeat(64), burnTxHash: '0x' + '1'.repeat(64) }],
      pending: null }));
    const publicBurns = await (await fetch(base + '/buybacks.json')).json();
    assert.equal(publicBurns.count, 1);
    assert.equal(publicBurns.totalSpentUsdg, '10');
    assert.equal(publicBurns.totalBurned, '500');
    rmSync(buybackPath);
    mkdirSync(join(directory, '.data'), { recursive: true });
    const ledgerPath = join(directory, '.data', 'exit-orders.json');
    const exitLedger = {
      version: 1, wallet: process.env.AGENT_PUBLIC_ADDRESS,
      AAPL: { soldQuantity: '1000000000000000000', soldCostUsdg: '100000000',
        pending: { orderId: 'private-pending-order' }, history: [
          { orderStatus: 'expired', orderId: 'private-expired-order' },
          { orderStatus: 'filled', amount: '1000000000000000000', acquisitionCostUsdg: '100000000',
            receivedUsdg: '110000000', txHash: '0x' + 'c'.repeat(64), filledAt: now },
        ] },
      NVDA: { soldQuantity: '500000000000000000', soldCostUsdg: '120000000',
        pending: null, history: [
          { orderStatus: 'filled', amount: '500000000000000000', acquisitionCostUsdg: '120000000',
            receivedUsdg: '115000000', txHash: '0x' + 'd'.repeat(64), filledAt: now },
        ] },
    };
    writeFileSync(ledgerPath, JSON.stringify(exitLedger));
    writeFileSync(join(directory, '.data', 'exit-basis.json'), JSON.stringify({
      version: 1, wallet: process.env.AGENT_PUBLIC_ADDRESS, throughBlock: 50,
      AAPL: { quantity: '1000000000000000000', spentUsdg: '100000000' },
      NVDA: { quantity: '500000000000000000', spentUsdg: '120000000' },
    }));
    const exitsResponse = await fetch(base + '/exits.json');
    assert.equal(exitsResponse.status, 200);
    const exits = await exitsResponse.json();
    assert.equal(exits.count, 2);
    assert.equal(exits.pendingCount, 1);
    assert.equal(exits.totalVerifiedAcquisitionUsdg, '220');
    assert.equal(exits.totalAcquisitionUsdg, '220');
    assert.equal(exits.totalProceedsUsdg, '225');
    assert.equal(exits.grossSpreadUsdg, '5');
    assert.equal(exits.sales.find(sale => sale.ticker === 'AAPL').grossSpreadUsdg, '10');
    assert.equal(exits.sales.find(sale => sale.ticker === 'NVDA').grossSpreadUsdg, '-5');
    assert.doesNotMatch(JSON.stringify(exits), /private-pending-order|private-expired-order/);
    exitLedger.NVDA.history[0].txHash = 'invalid';
    writeFileSync(ledgerPath, JSON.stringify(exitLedger));
    assert.equal((await fetch(base + '/exits.json')).status, 503);
    rmSync(ledgerPath);
    telemetry.recordActivity('exit_filled', 'AAPL sale recorded', 'Settlement verified.');
    assert.equal((await fetch(base + '/exits.json')).status, 503);

    const migrationAt = new Date().toISOString();
    telemetry.recordFundingTransition({ at: migrationAt });
    assert.equal(telemetry.publicStatus().creatorFeeTotals.apiPaidUsdg, '0');
    telemetry.recordActivity('api_paid', 'NVDA quote paid', '0.05 USDG settled.', {
      ticker: 'NVDA', amountUsdg: '0.05', txHash: '0x' + 'b'.repeat(64),
    });
    assert.equal(telemetry.publicStatus().creatorFeeTotals.apiPaidUsdg, '0.05');
    assert.equal(telemetry.publicStatus().totals.apiPaidUsdg, '0.1');

    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    server = null;
    const restarted = await import('../src/status.js?test=restart');
    assert.equal(restarted.publicStatus().totals.apiPaidUsdg, '0.1');
    assert.equal(restarted.publicStatus().creatorFeeTotals.apiPaidUsdg, '0.05');
    assert.equal(restarted.publicStatus().totalCycles, 1);
    assert.equal(restarted.publicStatus().portfolio.estimatedTotalUsdg, '100');
  } finally {
    if (server) await new Promise(done => server.close(done));
    process.chdir(previous);
    if (previousAddress === undefined) delete process.env.AGENT_PUBLIC_ADDRESS;
    else process.env.AGENT_PUBLIC_ADDRESS = previousAddress;
    if (previousChat === undefined) delete process.env.WEB_CHAT_ENABLED;
    else process.env.WEB_CHAT_ENABLED = previousChat;
    rmSync(directory, { recursive: true, force: true });
  }
});
