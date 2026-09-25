import 'dotenv/config';
import { parseUnits, isAddress } from 'viem';

export const CHAIN_ID = 4663;
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const AFTERHOURS = '0x6918EcC39996DAE959FBb7aAb1F6e926f285eBd4';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
// Only these tickers have operator-approved, directly USDG-paired execution pools.
export const WATCHLIST = ['NVDA', 'AAPL'];
const fundingMode = process.env.FUNDING_MODE || 'creator-fees';
if (!['creator-fees', 'wallet'].includes(fundingMode)) throw new Error('FUNDING_MODE must be creator-fees or wallet');

function amount(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error(`${name} must be a nonnegative USDG amount with at most 6 decimals`);
  return parseUnits(value, 6);
}
function percent(name, fallback, max = 100) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
function positive(name, fallback) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}
function nonnegativeInteger(name, fallback) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${name}`);
  return n;
}

const oracleUrl = new URL(process.env.ORACLE_URL || 'https://afterhoursoracle.xyz');
if (oracleUrl.protocol !== 'https:' || oracleUrl.hostname !== 'afterhoursoracle.xyz' || oracleUrl.pathname !== '/') {
  throw new Error('ORACLE_URL must be https://afterhoursoracle.xyz (payments are restricted to this host)');
}
const feeEscrow = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
const oraclePayTo = process.env.ORACLE_PAY_TO || '0x13c2C376eC8884099cb9424F4d97D32FD2a956Fa';
if (!isAddress(oraclePayTo)) throw new Error('Invalid payment recipient address');

export const config = {
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  oracleUrl: oracleUrl.toString().replace(/\/$/, ''),
  oraclePayTo,
  feeEscrow,
  ponsToken: process.env.PONS_TOKEN_ADDRESS || '',
  live: process.env.LIVE_TRADING === 'true',
  stockTokenEligibilityConfirmed: process.env.STOCK_TOKEN_ELIGIBILITY_CONFIRMED === 'true',
  fundingMode,
  migrateWalletToCreatorFees: process.env.MIGRATE_WALLET_TO_CREATOR_FEES === 'true',
  walletBudget: amount('WALLET_TOTAL_BUDGET_USDG', '0'),
  privateKey: process.env.AGENT_PRIVATE_KEY || '',
  minClaim: amount('MIN_CLAIM_USDG', '1'),
  buy: amount('BUY_USDG', '5'),
  maxDaily: amount('MAX_DAILY_USDG', '0'),
  maxApiDaily: amount('MAX_API_DAILY_USDG', '0'),
  maxApiFee: amount('MAX_API_FEE_USDG', '0.05'),
  minGasEth: process.env.MIN_GAS_ETH || '0.001',
  autoGasRefill: process.env.AUTO_GAS_REFILL_ENABLED === 'true',
  gasRefillUsdg: amount('GAS_REFILL_USDG', '10'),
  maxGasRefillDaily: amount('MAX_GAS_REFILL_DAILY_USDG', '30'),
  gasRefillSlippage: percent('GAS_REFILL_SLIPPAGE_PCT', '0.5', 2),
  minDiscount: percent('MIN_DISCOUNT_PCT', '0.6'),
  minExecutionDiscount: percent('MIN_EXECUTION_DISCOUNT_PCT', '0.6'),
  maxRouteMarkup: percent('MAX_ROUTE_MARKUP_PCT', '1'),
  maxSlippage: percent('MAX_SLIPPAGE_PCT', '0.25', 2),
  exitCostBufferPct: percent('EXIT_COST_BUFFER_PCT', '0.3', 10),
  // Zero disables the projected-profit gate; the estimate remains informational.
  minExpectedNetProfitPct: percent('MIN_EXPECTED_NET_PROFIT_PCT', '0', 100),
  estimatedGasUnitsPerLeg: positive('ESTIMATED_GAS_UNITS_PER_LEG', '250000'),
  maxSignalAgeSeconds: positive('MAX_SIGNAL_AGE_SECONDS', '45'),
  maxCloseAgeDays: positive('MAX_CLOSE_AGE_DAYS', '4'),
  maxBuysPerDay: nonnegativeInteger('MAX_BUYS_PER_DAY', '0'),
  pollMinutes: positive('POLL_MINUTES', '5'),
  exitEnabled: process.env.EXIT_ENABLED === 'true',
  uniswapApiKey: process.env.UNISWAP_API_KEY || process.env.UNISWA_API_KEY || '',
  exitWindowMinutes: positive('EXIT_WINDOW_MINUTES', '60'),
  exitMinProfitUsdg: amount('EXIT_MIN_PROFIT_USDG', '1'),
  buybackEnabled: process.env.BUYBACK_ENABLED === 'true',
  buybackMinimumUsdg: amount('BUYBACK_MIN_USDG', '1'),
  buybackMaximumUsdg: amount('BUYBACK_MAX_USDG', '100'),
  buybackCashReserveUsdg: amount('BUYBACK_CASH_RESERVE_USDG', '100'),
  buybackSlippagePct: percent('BUYBACK_SLIPPAGE_PCT', '0.5', 5),
  buybackMaxImpactPct: percent('BUYBACK_MAX_IMPACT_PCT', '2', 10),
};
if (config.buy <= 0n || config.buy > 1000_000000n) throw new Error('BUY_USDG must be between 0 and 1000');
if (config.maxApiFee <= 0n) throw new Error('MAX_API_FEE_USDG must be positive');
if (config.estimatedGasUnitsPerLeg > 2_000_000) throw new Error('ESTIMATED_GAS_UNITS_PER_LEG must be at most 2000000');
if (config.autoGasRefill && (config.gasRefillUsdg === 0n || config.gasRefillUsdg > 100_000000n ||
  config.maxGasRefillDaily < config.gasRefillUsdg)) {
  throw new Error('Auto gas refill needs a positive spend of at most 100 USDG within its daily cap');
}
if (config.fundingMode === 'wallet' && config.walletBudget <= 0n) {
  throw new Error('WALLET_TOTAL_BUDGET_USDG must be positive in wallet funding mode');
}
if (config.ponsToken && !isAddress(config.ponsToken)) throw new Error('Invalid PONS_TOKEN_ADDRESS');
if (config.migrateWalletToCreatorFees && (config.fundingMode !== 'creator-fees' || !config.ponsToken)) {
  throw new Error('Wallet-to-creator-fees migration requires creator-fees mode and PONS_TOKEN_ADDRESS');
}
if (config.live && !config.stockTokenEligibilityConfirmed) {
  throw new Error('Live Stock Token trading requires STOCK_TOKEN_ELIGIBILITY_CONFIRMED=true after jurisdictional review');
}
if (config.exitWindowMinutes > 390) throw new Error('EXIT_WINDOW_MINUTES must be at most 390');
if (config.exitEnabled && (!config.live || !config.uniswapApiKey)) {
  throw new Error('EXIT_ENABLED requires LIVE_TRADING=true and UNISWAP_API_KEY (or UNISWA_API_KEY)');
}
if (config.buybackEnabled && (!config.live || !config.ponsToken ||
    !isAddress(config.ponsToken) || config.ponsToken.toLowerCase() !== AFTERHOURS.toLowerCase())) {
  throw new Error('BUYBACK_ENABLED requires live trading and the pinned $AFTERHOURS token');
}
if (config.buybackMinimumUsdg <= 0n || config.buybackMaximumUsdg < config.buybackMinimumUsdg ||
    config.buybackMaximumUsdg > 100_000000n) {
  throw new Error('Buyback min/max must fit the bounded USDG route (up to 100 USDG)');
}
