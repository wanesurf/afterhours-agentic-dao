import { formatEther, formatUnits, parseEther } from 'viem';
import { config, EXPLORER, WATCHLIST } from './config.js';
import { signer, verifyLaunch, balances, claimRewards, ensureGas, GasReserveError, publicClient } from './chain.js';
import { Ledger, acquireLock, migrateWalletLedgerToCreatorFees } from './ledger.js';
import { fetchBoard, buySignal } from './oracle.js';
import { candidates, screenBoard, executionFloor, routeDiscount, validatePaidSignal } from './policy.js';
import { estimateRoundTripGasUsdg, projectedNetProfitAtClose } from './economics.js';
import { mcpWalletStatus } from './upstream.js';
import { quotePool, prepareV3Approval, swapV3 } from './v3.js';
import { creatorWallet, markCycleStarted, markCycleFinished, publicStatus, recordActivity, recordBoard, recordFundingTransition, recordFunds, recordPortfolio, startStatusServer } from './status.js';
import { SocialPublisher } from './social.js';
import { readPortfolio } from './portfolio.js';
import { nextCycleDelay } from './schedule.js';
import { recoverConfirmedClaim, recoverConfirmedSwap } from './reconcile.js';
import { GAS_POOL_ID, quoteGasRefill, prepareGasRefillApprovals, prepareGasRefillSwap, swapEarnedUsdgForGas } from './gas-refill.js';
import { runExitCycle } from './exit.js';
import { runBuybackCycle } from './buyback.js';
import { scanAcquisitions } from './exit-basis.js';
import { scanBuyHistory } from './buy-history.js';

const usd = value => formatUnits(value, 6);
let running = false;
let release = null;
let timer = null;
let buyHistoryScan = null;
let stage = 'market board';
const social = new SocialPublisher();

function publishFunds(balance, ledger, phase) {
  ledger.rollDay();
  recordFunds({
    phase,
    fundingMode: config.fundingMode,
    claimableUsdg: usd(balance.owed),
    walletUsdg: usd(balance.usdg),
    gasEth: formatEther(balance.eth),
    availableUsdg: usd(ledger.available(balance.usdg)),
    earnedAvailableUsdg: config.fundingMode === 'creator-fees' ? usd(ledger.available(balance.usdg)) : null,
    walletBudgetUsdg: config.fundingMode === 'wallet' ? usd(config.walletBudget) : null,
    apiSpentTodayUsdg: usd(BigInt(ledger.state.api)),
    tradeSpentTodayUsdg: usd(BigInt(ledger.state.trade)),
    gasRefillSpentTodayUsdg: usd(BigInt(ledger.state.gas)),
  });
}

function recordGasBlock(error) {
  recordActivity('gas_blocked', 'Agent needs ETH to run onchain',
    `Wallet gas is ${error.balanceEth} ETH, below the ${error.reserveEth} ETH reserve. ` +
    (config.autoGasRefill
      ? 'The agent checks its earned USDG and the approved ETH/USDG route each cycle; a swap still needs enough ETH to pay for its own gas.'
      : 'Automatic gas refills are disabled.'));
}

async function ensureAgentGas(identity, ledger, balance, phase) {
  if (balance.eth >= parseEther(config.minGasEth)) return balance;
  if (!config.autoGasRefill) {
    ensureGas(balance.eth);
    return balance;
  }
  stage = 'self-funded ETH gas refill';
  recordActivity('gas_refill_started', 'Refilling my own ETH gas',
    `Gas is below ${config.minGasEth} ETH. I am checking the approved ETH/USDG pool and my earned USDG before swapping.`);
  if (!ledger.canGas(config.gasRefillUsdg, config.maxGasRefillDaily, balance.usdg)) {
    recordActivity('gas_refill_blocked', 'Gas refill blocked by earned-funds budget',
      'The agent cannot spend unearned USDG or exceed its daily gas-refill allowance. Claims and buys are paused.');
    throw new GasReserveError(formatEther(balance.eth), config.minGasEth);
  }
  // An ERC-20 swap still needs native ETH to submit approvals and the swap.
  // Check a generous fee estimate before trying any transaction.
  const gasPrice = await publicClient.getGasPrice();
  if (balance.eth < gasPrice * 600_000n * 2n) {
    recordActivity('gas_refill_blocked', 'Initial ETH is too low for a self-refill',
      'An onchain USDG-to-ETH swap itself requires ETH gas. A one-time ETH deposit is needed before the agent can refill autonomously.');
    throw new GasReserveError(formatEther(balance.eth), config.minGasEth);
  }
  try {
    const quote = await quoteGasRefill(config.gasRefillUsdg);
    recordActivity('gas_refill_quote', 'Approved ETH/USDG pool quoted',
      `${usd(config.gasRefillUsdg)} earned USDG quotes ${formatEther(quote.amountOut)} ETH in pool ${GAS_POOL_ID}.`);
    const approvalTxs = await prepareGasRefillApprovals(identity, config.gasRefillUsdg);
    for (const hash of approvalTxs) recordActivity('gas_refill_approval', 'Gas swap allowance confirmed',
      'A bounded USDG allowance was confirmed onchain.', { txHash: hash });
    balance = await balances(identity.account.address);
    const prepared = await prepareGasRefillSwap(identity.account, config.gasRefillUsdg);
    if (!ledger.canGas(config.gasRefillUsdg, config.maxGasRefillDaily, balance.usdg)) {
      throw new Error('Eligible USDG changed before the gas swap');
    }
    ledger.reserve('gas', null, config.gasRefillUsdg, config.maxGasRefillDaily, null, balance.usdg);
    recordActivity('gas_refill_reserved', 'Earned USDG reserved for gas',
      `${usd(config.gasRefillUsdg)} USDG reserved before submitting the ETH refill. The swap enforces a minimum ETH output.`,
      { amountUsdg: usd(config.gasRefillUsdg) });
    const swap = await swapEarnedUsdgForGas(identity, config.gasRefillUsdg, prepared);
    recordActivity('gas_refill_confirmed', 'I bought my own ETH gas',
      `Swapped ${usd(swap.usdgSpent)} earned USDG for ${formatEther(swap.ethReceived)} ETH through the approved pool.`,
      { amountUsdg: usd(swap.usdgSpent), txHash: swap.hash });
    const after = await balances(identity.account.address);
    publishFunds(after, ledger, phase);
    ensureGas(after.eth);
    return after;
  } catch (error) {
    recordActivity('gas_refill_failed', 'My gas refill did not complete',
      'The approved swap route, allowance, or confirmation failed. No further trade will be attempted this cycle; the agent will check again next cycle.');
    throw error;
  }
}

async function cycle() {
  stage = 'Oracle board';
  const oracleBoard = await fetchBoard();
  stage = 'approved USDG pool quotes';
  const prices = await Promise.all(WATCHLIST.map(async ticker => {
    const oracle = oracleBoard.prices?.find(price => price.ticker === ticker);
    if (!oracle) return null;
    try {
      const quote = await quotePool(ticker, config.buy);
      return {
        ...oracle, onchain: quote.price,
        discount: Number.isFinite(oracle.close) && oracle.close > 0 ? (oracle.close - quote.price) / oracle.close * 100 : null,
        pool: quote.pool,
      };
    } catch (error) {
      console.error(`${ticker} approved pool quote failed: ${error.message}`);
      return { ...oracle, onchain: null, discount: null, pool: null };
    }
  }));
  const board = { ...oracleBoard, prices: prices.filter(Boolean), priceSource: 'approved-uniswap-v3-5-usdg-quote' };
  const observedAt = Date.now();
  const shortlist = candidates(board, config, observedAt);
  const rows = screenBoard(board, config, observedAt);
  recordBoard(board, rows, shortlist.map(item => item.ticker));
  recordActivity('board_checked', 'Oracle close and USDG pools screened',
    (board.nyseOpenNow === false ? 'NYSE closed. ' : 'NYSE open or state unavailable. ') +
    shortlist.length + ' watchlist candidate' + (shortlist.length === 1 ? '' : 's') + ' met the free-board screen.');
  console.log(`[${new Date().toISOString()}] NYSE open=${board.nyseOpenNow}; approved-pool dip candidates: ${shortlist.map(s => `${s.ticker} ${s.discount.toFixed(2)}%`).join(', ') || 'none'}`);
  if (config.exitEnabled) {
    stage = 'UniswapX treasury exit';
    await runExitCycle(board, signer());
  }
  if (config.buybackEnabled) {
    stage = 'profit buyback and burn';
    await runBuybackCycle(signer());
  }
  if (!config.live) {
    if (config.fundingMode === 'wallet') {
      const identity = signer();
      const ledger = new Ledger(identity.account.address, undefined,
        { fundingMode: 'wallet', walletBudget: config.walletBudget });
      const status = await balances(identity.account.address);
      publishFunds(status, ledger, 'wallet-funded');
      recordActivity('wallet_budget_ready', 'Wallet funding checked without spending',
        usd(ledger.available(status.usdg)) + ' USDG is available within the ' +
        usd(config.walletBudget) + ' USDG total cap; no paid action was attempted.');
      try { ensureGas(status.eth); }
      catch { recordActivity('gas_blocked', 'Waiting for ETH gas',
        'The wallet needs ETH on Robinhood Chain before paid actions can start.'); }
    }
    recordActivity('watch_only', 'Watching without trading',
      'Live trading is disabled. No API fee, claim, or stock-token purchase was attempted.');
    console.log('Read-only mode. Configure the selected funding source and gas before enabling LIVE_TRADING.');
    return;
  }

  stage = config.fundingMode === 'wallet' ? 'wallet budget verification' : 'Pons launch verification';
  const identity = signer();
  const launch = config.fundingMode === 'creator-fees' ? await verifyLaunch(identity.account.address) : null;
  if (launch && config.migrateWalletToCreatorFees) {
    const migration = migrateWalletLedgerToCreatorFees(identity.account.address, config.walletBudget);
    recordFundingTransition(migration);
  }
  const ledger = new Ledger(identity.account.address, undefined,
    { fundingMode: config.fundingMode, walletBudget: config.walletBudget,
      requireExisting: config.fundingMode === 'wallet' });
  if (launch) recordActivity('launch_verified', 'Pons launch verified',
    'The token is USDG paired and sends creator fees to this agent wallet.');
  else recordActivity('wallet_budget_active', 'Wallet USDG budget selected',
    usd(config.walletBudget) + ' USDG is the total spending limit for wallet-funded buys and Oracle fees. No Pons creator fees are assumed.');
  stage = 'wallet balances';
  let status = await balances(identity.account.address);
  const phase = launch?.phase ?? 'wallet-funded';
  publishFunds(status, ledger, phase);
  recordActivity('funds_checked', config.fundingMode === 'wallet' ? 'Wallet budget checked' : 'Creator-fee budget checked',
    config.fundingMode === 'wallet'
      ? usd(status.usdg) + ' USDG in the wallet; ' + usd(ledger.available(status.usdg)) + ' USDG within the fixed wallet spending cap.'
      : usd(status.owed) + ' USDG claimable; ' + usd(ledger.available(status.usdg)) + ' USDG earned and available.');
  console.log(`Funding=${config.fundingMode}; wallet=${usd(status.usdg)} USDG; gas=${formatEther(status.eth)} ETH; allowed available=${usd(ledger.available(status.usdg))} USDG`);
  status = await ensureAgentGas(identity, ledger, status, phase);
  let postClaim = status;
  if (launch) {
    stage = 'creator-fee claim';
    recordActivity('claim_check', 'Checking claimable fees', 'Claiming only when the configured minimum is available.');
    const claim = await claimRewards(identity, ledger);
    if (claim.claimed) recordActivity('claim_confirmed', 'Creator fees claimed',
      usd(claim.claimed) + ' USDG transferred from the Pons escrow and verified onchain.',
      { amountUsdg: usd(claim.claimed), txHash: claim.tx });
    else recordActivity('claim_not_ready', 'No claim made', 'Claimable fees were below the configured minimum.');
    postClaim = claim.claimed ? await balances(identity.account.address) : status;
    publishFunds(postClaim, ledger, phase);
    if (claim.claimed) console.log(`Claimed ${usd(claim.claimed)} USDG ${EXPLORER}/tx/${claim.tx}`);
  }
  if (!shortlist.length) {
    recordActivity('no_candidate', 'No candidate passed', 'Neither approved USDG pool offered a 5 USDG quote at least ' + config.minDiscount + '% below the last NYSE close.');
    return;
  }
  recordActivity('candidate_found', 'Executable discount candidate found',
    shortlist.map(item => item.ticker + ' ' + item.discount.toFixed(2) + '%').join(', ') +
    ' below the last NYSE close on the approved USDG pools. Final quotes still require checks.');

  let current = postClaim;
  if (ledger.available(current.usdg) < config.buy + config.maxApiFee || !ledger.canApi(config.maxApiFee, config.maxApiDaily, current.usdg)) {
    recordActivity('budget_blocked', 'Budget gate stopped trading',
      'Eligible USDG or the daily API allowance cannot cover one quote and one capped buy.');
    console.log('Insufficient eligible USDG or API allowance for a quote plus a buy.');
    return;
  }
  stage = 'gas and MCP wallet check';
  ensureGas(current.eth);
  await mcpWalletStatus(identity.account.address);
  recordActivity('wallet_verified', 'MCP wallet verified',
    'The After-Hours Dip Agent MCP wallet matches the configured agent wallet.');

  let bought = false;
  for (const item of shortlist) {
    current = await balances(identity.account.address);
    if (!ledger.canTrade(item.ticker, config.buy, config.maxDaily, config.maxBuysPerDay, current.usdg)) {
      recordActivity('policy_skipped', item.ticker + ' skipped by trade policy',
        'The eligible balance, daily trade cap, or one-buy-per-ticker rule blocked this candidate.', { ticker: item.ticker });
      continue;
    }
    if (!ledger.canApi(config.maxApiFee, config.maxApiDaily, current.usdg) || ledger.available(current.usdg) < config.buy + config.maxApiFee) {
      recordActivity('budget_blocked', 'API budget exhausted', 'No further paid quote is permitted this cycle.');
      break;
    }
    let initialQuote;
    let initialFloor;
    stage = item.ticker + ' direct pool quote';
    recordActivity('route_check', item.ticker + ' USDG pool check started',
      'Quoting the approved direct USDG/Stock Token pool before paying for an Oracle signal.', { ticker: item.ticker });
    try {
      initialQuote = await quotePool(item.ticker, config.buy);
      routeDiscount(initialQuote.price, item.close, config);
      initialFloor = executionFloor({ lastNyseClose: item.close, onchainPrice: item.onchain },
        config.buy, initialQuote.amountOut, config);
      recordActivity('route_passed', item.ticker + ' USDG pool passed',
        '5 USDG quote: ' + initialQuote.price.toFixed(4) + ' USDG per Stock Token at the approved 0.05% pool.', { ticker: item.ticker });
    } catch (e) {
      recordActivity('route_rejected', item.ticker + ' free route rejected',
        'The swap route was unavailable or failed the price screen. No paid Oracle quote was requested.',
        { ticker: item.ticker });
      console.log(`${item.ticker}: executable route failed free-board price screen (${e.message}); no API fee paid`);
      continue;
    }
    let estimatedGasUsdg = null;
    let projected = null;
    try {
      estimatedGasUsdg = await estimateRoundTripGasUsdg(config.estimatedGasUnitsPerLeg);
      projected = projectedNetProfitAtClose({
        minOut: initialFloor.minOut, referenceClose: item.close, buyUsdg: config.buy,
        oracleFeeUsdg: config.maxApiFee, gasUsdg: estimatedGasUsdg,
        exitCostBufferPct: config.exitCostBufferPct,
        minExpectedNetProfitPct: config.minExpectedNetProfitPct,
      });
    } catch (e) {
      estimatedGasUsdg = null;
      recordActivity('cost_check_unavailable', item.ticker + ' cost check unavailable',
        config.minExpectedNetProfitPct === 0
          ? 'The agent could not estimate gas and exit costs. The estimate is informational; the approved price and budget checks still apply.'
          : 'The agent could not price its expected gas and exit costs. No paid Oracle quote was requested.',
        { ticker: item.ticker });
      console.error(`${item.ticker}: prepayment cost check unavailable (${e.message})`);
      if (config.minExpectedNetProfitPct > 0) continue;
    }
    if (projected && !projected.passes) {
      recordActivity('cost_rejected', item.ticker + ` expected return below ${config.minExpectedNetProfitPct}% minimum`,
        `Estimated net at the NYSE close is ${usd(projected.estimatedNetProfitUsdg)} USDG after the maximum Oracle fee, ` +
        `a ${config.exitCostBufferPct}% exit allowance, and ${usd(estimatedGasUsdg)} USDG estimated round-trip gas. ` +
        `At least ${usd(projected.minimumProfitUsdg)} USDG is required. No paid quote was requested.`,
        { ticker: item.ticker });
      continue;
    }
    if (projected) recordActivity(config.minExpectedNetProfitPct === 0 ? 'cost_estimated' : 'cost_passed',
      item.ticker + (config.minExpectedNetProfitPct === 0 ? ' projected return noted' : ' expected return passed'),
      `Estimated net at the last NYSE close is ${usd(projected.estimatedNetProfitUsdg)} USDG after the maximum Oracle fee, ` +
      `a ${config.exitCostBufferPct}% exit allowance, and ${usd(estimatedGasUsdg)} USDG estimated round-trip gas. ` +
      (config.minExpectedNetProfitPct === 0
        ? 'This is informational; requesting a fresh paid Oracle quote.'
        : `This is above the ${config.minExpectedNetProfitPct}% minimum; requesting a fresh paid Oracle quote.`),
      { ticker: item.ticker });
    try {
      // Do approvals before buying a fresh paid quote. They spend ETH gas, not USDG.
      stage = item.ticker + ' swap approvals';
      recordActivity('approval_check', item.ticker + ' allowances checked',
        'Preparing exact USDG swap allowances before requesting a paid quote.', { ticker: item.ticker });
      const approvals = await prepareV3Approval(identity, config.buy);
      for (const hash of approvals) recordActivity('approval_confirmed', item.ticker + ' allowance confirmed',
        'An onchain allowance transaction completed.', { ticker: item.ticker, txHash: hash });
      if (!approvals.length) recordActivity('approval_existing', item.ticker + ' allowances already sufficient',
        'No new allowance transaction was needed.', { ticker: item.ticker });
      current = await ensureAgentGas(identity, ledger, await balances(identity.account.address), phase);
      stage = item.ticker + ' paid Oracle quote';
      recordActivity('api_request', item.ticker + ' paid quote requested',
        'Checking the Oracle x402 price and payment recipient against the configured cap.', { ticker: item.ticker });
      const { signal, fee, paymentTx } = await buySignal(item.ticker, identity, ledger, current.usdg);
      recordActivity('api_paid', item.ticker + ' Oracle quote paid',
        usd(fee) + ' USDG payment settled on Robinhood Chain.', { ticker: item.ticker, amountUsdg: usd(fee), txHash: paymentTx });
      console.log(`Paid ${usd(fee)} USDG for ${item.ticker}: ${EXPLORER}/tx/${paymentTx}`);
      stage = item.ticker + ' paid signal validation';
      validatePaidSignal(signal, item.ticker, config);
      routeDiscount(initialQuote.price, signal.lastNyseClose, config);
      recordActivity('signal_validated', item.ticker + ' paid signal validated',
        'Fresh NYSE close, source, and market checks passed. The old Oracle onchain pool price is not used for execution.',
        { ticker: item.ticker });
      const finalQuote = await quotePool(item.ticker, config.buy);
      const { minOut, routePrice } = executionFloor(
        { lastNyseClose: signal.lastNyseClose, onchainPrice: initialQuote.price },
        config.buy, finalQuote.amountOut, config);
      const finalGasUsdg = config.minExpectedNetProfitPct === 0
        ? estimatedGasUsdg : await estimateRoundTripGasUsdg(config.estimatedGasUnitsPerLeg);
      if (finalGasUsdg !== null) {
        try {
          const finalProjection = projectedNetProfitAtClose({
            minOut, referenceClose: signal.lastNyseClose, buyUsdg: config.buy,
            oracleFeeUsdg: fee, gasUsdg: finalGasUsdg,
            exitCostBufferPct: config.exitCostBufferPct,
            minExpectedNetProfitPct: config.minExpectedNetProfitPct,
          });
          if (!finalProjection.passes) {
            recordActivity('cost_rejected_final', item.ticker + ' final expected return fell below minimum',
              `The final route estimates ${usd(finalProjection.estimatedNetProfitUsdg)} USDG net at the NYSE close, ` +
              `below the required ${usd(finalProjection.minimumProfitUsdg)} USDG. No stock purchase was attempted.`,
              { ticker: item.ticker });
            continue;
          }
          if (config.minExpectedNetProfitPct === 0) recordActivity('cost_estimated_final',
            item.ticker + ' final projected return noted',
            `The final route estimates ${usd(finalProjection.estimatedNetProfitUsdg)} USDG at the last NYSE close after the Oracle fee, ` +
            `exit allowance, and estimated gas. This estimate does not block the swap.`, { ticker: item.ticker });
        } catch (e) {
          if (config.minExpectedNetProfitPct > 0) throw e;
          recordActivity('cost_check_unavailable', item.ticker + ' final cost estimate unavailable',
            'The final return estimate could not be calculated. The approved price and budget checks still apply.',
            { ticker: item.ticker });
        }
      }
      recordActivity('execution_passed', item.ticker + ' execution price passed',
        'Current route: ' + routePrice.toFixed(4) + ' USDG per Stock Token; minimum output is enforced onchain.',
        { ticker: item.ticker });
      if (!ledger.canTrade(item.ticker, config.buy, config.maxDaily, config.maxBuysPerDay, (await balances(identity.account.address)).usdg)) {
        recordActivity('policy_skipped', item.ticker + ' final budget gate stopped buy',
          'The eligible balance or daily trade allowance changed after the paid quote.', { ticker: item.ticker });
        continue;
      }
      // If the quote or approvals took too long, do not trade on an old signal.
      validatePaidSignal(signal, item.ticker, config);
      await ensureAgentGas(identity, ledger, await balances(identity.account.address), phase);
      validatePaidSignal(signal, item.ticker, config);
      stage = item.ticker + ' stock-token swap';
      ledger.reserve('trade', item.ticker, config.buy, config.maxDaily, config.maxBuysPerDay, (await balances(identity.account.address)).usdg);
      recordActivity('trade_reserved', item.ticker + ' purchase budget reserved',
        usd(config.buy) + ' USDG reserved before submitting the swap.', { ticker: item.ticker, amountUsdg: usd(config.buy) });
      const swap = await swapV3(identity, item.ticker, config.buy, minOut);
      if (swap.status !== 'success') throw new Error(`Swap reverted: ${swap.hash}`);
      recordActivity('buy_confirmed', item.ticker + ' Stock Tokens bought',
        usd(config.buy) + ' USDG spent at a route quote of ' + routePrice.toFixed(4) + ' USDG per token.',
        { ticker: item.ticker, amountUsdg: usd(config.buy), txHash: swap.hash });
      bought = true;
      publishFunds(await balances(identity.account.address), ledger, phase);
      console.log(`Bought ${item.ticker} for ${usd(config.buy)} USDG at route quote ${routePrice.toFixed(4)}; minimum ${formatUnits(minOut, 18)} Stock Tokens; ${EXPLORER}/tx/${swap.hash}`);
      break; // one trade per cycle
    } catch (e) {
      if (e instanceof GasReserveError) recordGasBlock(e);
      else recordActivity('attempt_stopped', item.ticker + ' attempt stopped',
        'A validation, payment, or swap step failed. The agent will not retry this candidate in the same cycle.',
        { ticker: item.ticker });
      console.error(`${item.ticker} skipped: ${e.message}`);
      // After an uncertain paid call or transaction, stop to avoid repeat spending.
      break;
    }
  }
  if (!bought) recordActivity('no_trade', 'No purchase this cycle',
    'Candidates were blocked by the budget, route, or final validation checks.');
}

async function tick() {
  if (running) return;
  running = true;
  let cycleSuccess = false;
  markCycleStarted();
  try { await cycle(); markCycleFinished(true); cycleSuccess = true; }
  catch (e) {
    if (e instanceof GasReserveError) recordGasBlock(e);
    else recordActivity('stage_failed', 'Stopped at ' + stage,
      'This step did not complete. The public dashboard omits raw diagnostic details; inspect Railway logs.');
    markCycleFinished(false);
    console.error(`Cycle failed: ${e.message}`);
    if (!process.argv.includes('--watch')) process.exitCode = 1;
  }
  finally {
    if (creatorWallet) {
      try { recordPortfolio(await readPortfolio(creatorWallet)); }
      catch (error) {
        recordActivity('portfolio_refresh_failed', 'Portfolio update failed',
          'The last saved holdings remain visible. The wallet will be checked again next cycle.');
        console.error('Portfolio update failed: ' + error.message);
      }
    }
    if (config.exitEnabled && creatorWallet && publicStatus().board?.nyseOpenNow === false) {
      try { await scanAcquisitions(creatorWallet); }
      catch (error) {
        recordActivity('exit_basis_warm_failed', 'Pre-open sale receipt scan needs retry',
          'The read-only purchase receipt check did not finish. The agent will retry before or during the opening window.');
        console.error('Pre-open exit receipt scan failed: ' + error.message);
      }
    }
    try { await social.flush({ cycleSuccess }); }
    catch (error) {
      recordActivity('x_post_stage_failed', 'X publishing stopped',
        'The social publishing step could not complete. See operator logs; trading status is separate.');
      console.error('Social publishing failed: ' + error.message);
    }
    if (process.argv.includes('--watch') && creatorWallet &&
        publicStatus().board?.nyseOpenNow === false && !buyHistoryScan) {
      buyHistoryScan = scanBuyHistory(creatorWallet)
        .catch(error => console.error('Purchase history scan failed: ' + error.message))
        .finally(() => { buyHistoryScan = null; });
    }
    running = false;
  }
}

if ((config.live || process.env.X_POSTING_ENABLED === 'true') && process.env.RAILWAY_PROJECT_ID &&
    process.env.RAILWAY_VOLUME_MOUNT_PATH !== '/app/.data') {
  throw new Error('Live Railway trading or X publishing requires a persistent volume mounted at /app/.data');
}
if (config.live) release = acquireLock();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (timer) clearInterval(timer);
  release?.();
  release = null;
  process.exit(0);
});
try {
  if (process.env.RECOVER_CLAIM_TX_HASH) {
    await recoverConfirmedClaim(process.env.RECOVER_CLAIM_TX_HASH, creatorWallet);
  }
  if (process.env.RECOVER_SWAP_TX_HASH) {
    const recovered = await recoverConfirmedSwap(process.env.RECOVER_SWAP_TX_HASH, creatorWallet);
    if (recovered) {
      recordPortfolio(await readPortfolio(creatorWallet));
      await social.flush();
    }
  }
  if (process.argv.includes('--watch')) {
    await startStatusServer();
    const delay = nextCycleDelay(publicStatus(), config.pollMinutes);
    if (delay > 0) {
      console.log(`Resuming market checks in ${Math.ceil(delay / 1000)} seconds after the previous check.`);
      await new Promise(resolve => { timer = setTimeout(resolve, delay); });
      timer = null;
    }
  }
  await tick();
  if (process.argv.includes('--watch')) {
    console.log(`Watching every ${config.pollMinutes} minutes. Press Ctrl+C to stop.`);
    timer = setInterval(tick, config.pollMinutes * 60_000);
  } else { release?.(); release = null; }
} catch (e) {
  release?.();
  throw e;
}
