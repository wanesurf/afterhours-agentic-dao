import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x402Client } from '@x402/fetch';
import { Ledger, migrateWalletLedgerToCreatorFees } from '../src/ledger.js';
import { parsePriceChallenge, guardedOracleFetch, oracleSpendControls } from '../src/oracle.js';
import { USDG } from '../src/config.js';

test('only claims can fund API/trades and reservations survive reloads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pons-ledger-'));
  try {
    const path = join(directory, 'state.json');
    const address = '0x1111111111111111111111111111111111111111';
    const ledger = new Ledger(address, path);
    const balance = 2_000_000n;
    assert.equal(ledger.canApi(50_000n, 100_000n, balance), false);
    ledger.creditClaim(2_000_000n, `0x${'a'.repeat(64)}`);
    assert.throws(() => ledger.creditClaim(2_000_000n, `0x${'a'.repeat(64)}`));
    ledger.reserve('api', null, 50_000n, 100_000n, null, balance);
    ledger.reserve('trade', 'AAPL', 1_000_000n, 1_000_000n, 1, balance - 50_000n);
    const restarted = new Ledger(address, path);
    assert.equal(restarted.available(balance - 1_050_000n), 950_000n);
    assert.equal(restarted.canTrade('AAPL', 1_000_000n, 1_000_000n, 1, balance), false);
    assert.throws(() => new Ledger('0x2222222222222222222222222222222222222222', path));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('wallet funding spends only its fixed total cap, even across restarts and deposits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-ledger-'));
  try {
    const path = join(directory, 'state.json');
    const address = '0x1111111111111111111111111111111111111111';
    const options = { fundingMode: 'wallet', walletBudget: 50_000_000n };
    assert.throws(() => new Ledger(address, path, { ...options, requireExisting: true }), /missing/);
    const ledger = new Ledger(address, path, options);
    assert.equal(ledger.available(99_000_000n), 50_000_000n);
    assert.throws(() => ledger.creditClaim(1_000_000n, `0x${'a'.repeat(64)}`), /cannot be credited/);
    ledger.reserve('api', null, 50_000n, 500_000n, null, 99_000_000n);
    ledger.reserve('trade', 'AAPL', 5_000_000n, 15_000_000n, 2, 98_950_000n);
    const restarted = new Ledger(address, path, options);
    assert.equal(new Ledger(address, path, { ...options, requireExisting: true }).available(200_000_000n), 44_950_000n);
    assert.equal(restarted.available(200_000_000n), 44_950_000n);
    assert.equal(restarted.canTrade('AAPL', 5_000_000n, 15_000_000n, 2, 200_000_000n), false);
    assert.throws(() => new Ledger(address, path, { fundingMode: 'wallet', walletBudget: 100_000_000n }),
      /wallet budget changed/);
    assert.throws(() => new Ledger(address, path), /funding source/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('zero removes daily trade limits while the fixed wallet total still stops spending', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-count-'));
  try {
    const ledger = new Ledger('0x1111111111111111111111111111111111111111',
      join(directory, 'state.json'), { fundingMode: 'wallet', walletBudget: 50_000_000n });
    for (let n = 0; n < 10; n++) {
      assert.equal(ledger.canTrade('AAPL', 5_000_000n, 0n, 0, 50_000_000n), true);
      ledger.reserve('trade', 'AAPL', 5_000_000n, 0n, 0, 50_000_000n);
    }
    assert.equal(ledger.canTrade('AAPL', 5_000_000n, 0n, 0, 50_000_000n), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('zero removes the daily Oracle allowance while earned funds still bound payments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-unlimited-'));
  try {
    const ledger = new Ledger('0x1111111111111111111111111111111111111111',
      join(directory, 'state.json'));
    ledger.creditClaim(200_000n, `0x${'c'.repeat(64)}`);
    for (let n = 0; n < 4; n++) {
      assert.equal(ledger.canApi(50_000n, 0n, 200_000n), true);
      ledger.reserve('api', null, 50_000n, 0n, null, 200_000n);
    }
    assert.equal(ledger.state.api, '200000');
    assert.equal(ledger.canApi(50_000n, 0n, 200_000n), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('verified launch migration preserves wallet history without counting it as creator revenue', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pons-migration-'));
  try {
    const path = join(directory, 'state.json');
    const address = '0x1111111111111111111111111111111111111111';
    const wallet = new Ledger(address, path, { fundingMode: 'wallet', walletBudget: 50_000_000n });
    wallet.reserve('api', null, 50_000n, 500_000n, null, 50_000_000n);
    wallet.reserve('trade', 'AAPL', 5_000_000n, 0n, 0, 49_950_000n);
    assert.throws(() => migrateWalletLedgerToCreatorFees(address, 60_000_000n, path), /wallet budget changed/);
    const migration = migrateWalletLedgerToCreatorFees(address, 50_000_000n, path);
    assert.equal(migration.walletReserved, '5050000');
    const backup = JSON.parse(readFileSync(path + '.wallet-before-creator-fees.json', 'utf8'));
    assert.equal(backup.fundingMode, 'wallet');
    assert.equal(backup.reserved, '5050000');
    assert.equal(migrateWalletLedgerToCreatorFees(address, 50_000_000n, path).at, migration.at);
    const creator = new Ledger(address, path, { fundingMode: 'creator-fees', requireExisting: true });
    assert.equal(creator.available(100_000_000n), 0n);
    assert.equal(creator.state.api, '50000');
    assert.equal(creator.state.trade, '5000000');
    assert.deepEqual(creator.state.buys, ['AAPL']);
    creator.creditClaim(2_000_000n, `0x${'b'.repeat(64)}`);
    assert.equal(creator.available(100_000_000n), 2_000_000n);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('oracle challenge only permits the expected USDG rail and capped recipient', () => {
  const recipient = '0x1111111111111111111111111111111111111111';
  const challenge = (amount, payTo = recipient, asset = USDG) => Buffer.from(JSON.stringify({
    x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:4663', asset, payTo, amount }],
  })).toString('base64');
  assert.equal(parsePriceChallenge(challenge('50000'), recipient, 50_000n), 50_000n);
  assert.throws(() => parsePriceChallenge(challenge('50001'), recipient, 50_000n));
  assert.throws(() => parsePriceChallenge(challenge('50000', '0x2222222222222222222222222222222222222222'), recipient, 50_000n));
});

test('oracle terms changing between preflight and payment are rejected', async () => {
  const recipient = '0x13c2C376eC8884099cb9424F4d97D32FD2a956Fa';
  const url = 'https://afterhoursoracle.xyz/price/AAPL';
  const changed = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{
    scheme: 'exact', network: 'eip155:4663', asset: USDG, payTo: recipient, amount: '50000',
  }] })).toString('base64');
  const fakeFetch = async () => ({ url, status: 402, headers: new Headers({ 'payment-required': changed }) });
  await assert.rejects(guardedOracleFetch(url, 40_000n, fakeFetch)(url), /changed after fee reservation/);
});

test('x402 client accepts only capped USDG on Robinhood Chain', () => {
  const client = new x402Client()
    .register('eip155:4663', { scheme: 'exact' })
    .setSpendControls(oracleSpendControls(50_000n));
  const requirement = {
    scheme: 'exact', network: 'eip155:4663', asset: USDG,
    payTo: '0x13c2C376eC8884099cb9424F4d97D32FD2a956Fa', amount: '50000',
  };
  assert.equal(client.selectPaymentRequirements(2, [requirement]), requirement);
  assert.throws(() => client.selectPaymentRequirements(2, [{ ...requirement, amount: '50001' }]), /allowedAssets maxAmountPerPayment/);
  assert.throws(() => client.selectPaymentRequirements(2, [{ ...requirement, asset: '0x1111111111111111111111111111111111111111' }]), /only default assets/);
});
