import { mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { isAddressEqual } from 'viem';

const defaultPath = resolve('.data/state.json');
const today = () => new Date().toISOString().slice(0, 10);

export class Ledger {
  constructor(address, path = defaultPath,
    { fundingMode = 'creator-fees', walletBudget = 0n, requireExisting = false } = {}) {
    if (!['creator-fees', 'wallet'].includes(fundingMode) || typeof walletBudget !== 'bigint' ||
      walletBudget < 0n || (fundingMode === 'wallet' && walletBudget === 0n)) {
      throw new Error('Invalid ledger funding configuration');
    }
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.state = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (requireExisting) throw new Error('Wallet spending ledger is missing; stop and reconcile before trading');
      this.state = { version: 1, address, fundingMode, walletBudget: walletBudget.toString(),
        claimed: '0', reserved: '0', claimHashes: [], day: today(), api: '0', trade: '0', gas: '0', buys: [] };
      this.save();
    }
    if (this.state.version !== 1 || !isAddressEqual(this.state.address, address)) throw new Error('Ledger wallet mismatch; stop and investigate before trading');
    // Old ledgers can continue in creator-fee mode. Switching an existing ledger's
    // funding source or changing its total wallet cap requires manual review.
    const savedMode = this.state.fundingMode || 'creator-fees';
    if (savedMode !== fundingMode || (fundingMode === 'wallet' && this.state.walletBudget !== walletBudget.toString())) {
      throw new Error('Ledger funding source or wallet budget changed; stop and reconcile before trading');
    }
    // Fail closed on corrupt or tampered files.
    if (this.state.gas === undefined) this.state.gas = '0';
    for (const key of ['claimed', 'reserved', 'api', 'trade', 'gas']) {
      if (!/^\d+$/.test(this.state[key])) throw new Error(`Invalid ledger ${key}`);
    }
    if (!Array.isArray(this.state.claimHashes) || !Array.isArray(this.state.buys)) throw new Error('Invalid ledger arrays');
    if (fundingMode === 'wallet' && BigInt(this.state.reserved) > walletBudget) {
      throw new Error('Wallet spending exceeds the configured total budget');
    }
    this.fundingMode = fundingMode;
    this.walletBudget = walletBudget;
  }

  save() {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  rollDay() {
    if (this.state.day === today()) return;
    this.state.day = today();
    this.state.api = '0';
    this.state.trade = '0';
    this.state.gas = '0';
    this.state.buys = [];
    this.save();
  }

  creditClaim(amount, hash) {
    if (this.fundingMode !== 'creator-fees') throw new Error('Pons claims cannot be credited in wallet funding mode');
    if (amount <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid claim credit');
    if (this.state.claimHashes.includes(hash)) throw new Error('Claim transaction already credited');
    this.state.claimed = (BigInt(this.state.claimed) + amount).toString();
    this.state.claimHashes.push(hash);
    this.save();
  }

  available(walletBalance) {
    const budget = this.fundingMode === 'wallet' ? this.walletBudget : BigInt(this.state.claimed);
    const available = budget - BigInt(this.state.reserved);
    return available > 0n ? (available < walletBalance ? available : walletBalance) : 0n;
  }

  canApi(amount, cap, walletBalance) {
    this.rollDay();
    return amount > 0n && (cap === 0n || BigInt(this.state.api) + amount <= cap) &&
      this.available(walletBalance) >= amount;
  }

  canTrade(ticker, amount, cap, maxBuys, walletBalance) {
    this.rollDay();
    return amount > 0n && (cap === 0n || BigInt(this.state.trade) + amount <= cap) &&
      (maxBuys === 0 || (this.state.buys.length < maxBuys && !this.state.buys.includes(ticker))) &&
      this.available(walletBalance) >= amount;
  }

  canGas(amount, cap, walletBalance) {
    this.rollDay();
    return amount > 0n && cap > 0n && BigInt(this.state.gas) + amount <= cap &&
      this.available(walletBalance) >= amount;
  }

  reserve(kind, ticker, amount, cap, maxBuys, walletBalance) {
    const allowed = kind === 'api' ? this.canApi(amount, cap, walletBalance) :
      kind === 'trade' ? this.canTrade(ticker, amount, cap, maxBuys, walletBalance) :
        kind === 'gas' ? this.canGas(amount, cap, walletBalance) : false;
    if (!allowed) throw new Error(`Insufficient eligible balance or daily ${kind} limit reached`);
    this.state.reserved = (BigInt(this.state.reserved) + amount).toString();
    this.state[kind] = (BigInt(this.state[kind]) + amount).toString();
    if (kind === 'trade') this.state.buys.push(ticker);
    // Reservations remain charged when a remote call fails or process crashes.
    this.save();
  }
}

// Run only after the Pons factory confirms the token, USDG pair, and fee recipient.
// Keep the old wallet ledger as an immutable audit copy. Prior wallet spending must
// never become creator-fee credit, while today's Oracle usage still counts.
export function migrateWalletLedgerToCreatorFees(address, walletBudget, path = defaultPath) {
  const current = JSON.parse(readFileSync(path, 'utf8'));
  if (current.fundingMode === 'creator-fees') {
    new Ledger(address, path, { fundingMode: 'creator-fees', requireExisting: true });
    if (current.migration?.source !== 'wallet' || current.migration.walletBudget !== walletBudget.toString()) {
      throw new Error('Creator-fee ledger has no matching wallet migration record');
    }
    return current.migration;
  }
  const wallet = new Ledger(address, path, { fundingMode: 'wallet', walletBudget, requireExisting: true });
  if (wallet.state.claimed !== '0' || wallet.state.claimHashes.length) {
    throw new Error('Wallet ledger unexpectedly contains creator claims');
  }
  const original = readFileSync(path, 'utf8');
  const backup = path + '.wallet-before-creator-fees.json';
  try { writeFileSync(backup, original, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || readFileSync(backup, 'utf8') !== original) throw error;
  }
  const migration = {
    source: 'wallet', at: new Date().toISOString(), walletBudget: walletBudget.toString(),
    walletReserved: wallet.state.reserved, backup: backup.split('/').at(-1),
  };
  wallet.state = {
    ...wallet.state, fundingMode: 'creator-fees', walletBudget: '0',
    claimed: '0', reserved: '0', claimHashes: [], migration,
  };
  wallet.save();
  return migration;
}

// Only one process may claim, pay, and trade against a ledger at a time.
export function acquireLock(path = resolve('.data/agent.lock')) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Agent already running or stale lock at ${path}; inspect it before removal`); throw e; }
  writeFileSync(fd, `${process.pid}\n`);
  return () => { closeSync(fd); unlinkSync(path); };
}
