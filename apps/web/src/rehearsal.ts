import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AAPL_MARKETS, AAPL_FEED_IDS, type ReferencePrice, type AaplMarketSymbol } from '../../../services/arbitrage-mcp/src/markets.js';
import { analyzePrices, scanConvergence, type MarketState } from '../../../services/arbitrage-mcp/src/scanner.js';
import { validateTrade, type StrategyMandate, type ProposedTrade } from '../../../services/execution-mcp/src/policy.js';

const raw = z.string().regex(/^(0|[1-9]\d*)$/).max(30);
export const rehearsalMandateSchema = z.object({
  schemaVersion: z.literal(1), strategy: z.literal('aapl-convergence'),
  asset: z.enum([AAPL_MARKETS.xStocks, AAPL_MARKETS.ondo]), venue: z.literal('meteora-dlmm'),
  budgetUsdcRaw: raw, maxTradeUsdcRaw: raw,
  maximumSlippageBps: z.number().int().min(0).max(500),
  minimumNetEdgeBps: z.number().int().min(0).max(10_000),
  expiresAtMs: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (![value.budgetUsdcRaw, value.maxTradeUsdcRaw].every(raw => /^(0|[1-9]\d*)$/.test(raw) && raw.length <= 30)) return;
  const budget = BigInt(value.budgetUsdcRaw), trade = BigInt(value.maxTradeUsdcRaw);
  if (budget <= 0n || budget > 1_000_000_000_000n || trade <= 0n || trade > budget) {
    context.addIssue({ code: 'custom', path: ['budgetUsdcRaw'], message: 'Use a positive rehearsal budget up to 1,000,000 USDC and a trade cap no larger than the budget.' });
  }
});

export const REHEARSAL_SCENARIOS = ['within-limits', 'over-budget', 'stale-price', 'paused', 'expired', 'no-discount'] as const;
export type RehearsalScenario = typeof REHEARSAL_SCENARIOS[number];
export const hashRecord = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Deliberately separate synthetic policy cases from live chain and price evidence. */
export function runRehearsal(scenario: RehearsalScenario, nowMs = Date.now()) {
  if (!REHEARSAL_SCENARIOS.includes(scenario)) throw new Error('Unknown rehearsal scenario');
  const manifest = rehearsalMandateSchema.parse({ schemaVersion: 1, strategy: 'aapl-convergence',
    asset: AAPL_MARKETS.xStocks, venue: 'meteora-dlmm', budgetUsdcRaw: '100000000', maxTradeUsdcRaw: '25000000',
    maximumSlippageBps: 50, minimumNetEdgeBps: 50, expiresAtMs: nowMs + 3_600_000 });
  const price = (symbol: AaplMarketSymbol, usd: number): ReferencePrice => ({ symbol, feedId: AAPL_FEED_IDS[symbol],
    priceUsd: usd, confidenceUsd: .04, priceMantissa: String(usd * 100_000), confidenceMantissa: '4000', exponent: -5,
    observedAtMs: nowMs, feedUpdatedAtMs: nowMs - (scenario === 'stale-price' ? 30_000 : 500), marketSession: 'regular', publisherCount: 4 });
  const state = analyzePrices({ [AAPL_MARKETS.equity]: price(AAPL_MARKETS.equity, 200),
    [AAPL_MARKETS.xStocks]: price(AAPL_MARKETS.xStocks, scenario === 'no-discount' ? 201 : 195),
    [AAPL_MARKETS.ondo]: price(AAPL_MARKETS.ondo, 198) }, nowMs);
  const mandate: StrategyMandate = { id: `rehearsal:${hashRecord(manifest)}`, activeFromMs: nowMs - 60_000,
    expiresAtMs: scenario === 'expired' ? nowMs - 1 : manifest.expiresAtMs,
    allowedSymbols: [manifest.asset], allowedVenues: [manifest.venue], maximumTradeUsd: Number(BigInt(manifest.maxTradeUsdcRaw)) / 1_000_000,
    maximumStrategyExposureUsd: Number(BigInt(manifest.budgetUsdcRaw)) / 1_000_000, maximumSlippageBps: manifest.maximumSlippageBps,
    minimumNetProfitBps: manifest.minimumNetEdgeBps, maximumQuoteAgeMs: 5_000, emergencyPaused: scenario === 'paused' };
  const trade: ProposedTrade = { symbol: manifest.asset, venue: manifest.venue, notionalUsd: scenario === 'over-budget' ? 101 : 20,
    estimatedSlippageBps: 20, expectedNetProfitBps: 180, quotedAtMs: nowMs - 100, quoteExpiresAtMs: nowMs + 4_000 };
  const signal = scanConvergence(state, 50).signals.find(signal => signal.buySymbol === manifest.asset);
  const riskFailures = validateTrade(mandate, trade, { exposureUsd: 0 }, nowMs);
  const marketFailures = signal ? state.markets.filter(row => [AAPL_MARKETS.equity, manifest.asset].includes(row.symbol as typeof AAPL_MARKETS.equity))
    .flatMap(row => row.issues) : ['NO_QUALIFYING_DISCOUNT'];
  const reasons = [...new Set([...marketFailures, ...riskFailures])];
  const record = {
    schemaVersion: 1, kind: 'policy-rehearsal', source: 'synthetic-fixtures', scenario,
    recordedAt: new Date(nowMs).toISOString(), manifest, manifestHash: hashRecord(manifest),
    stages: [
      { name: 'Mandate schema', status: 'PASS', detail: 'Structured rehearsal draft; it has not been submitted or voted on.' },
      { name: 'Reference prices', status: marketFailures.length ? 'REJECT' : 'PASS', detail: marketFailures.join('; ') || 'Synthetic prices meet freshness, confidence, session and discount checks.' },
      { name: 'Risk limits', status: riskFailures.length ? 'REJECT' : 'PASS', detail: riskFailures.join('; ') || 'Fixture quote and fixture exposure are inside the rehearsal limits.' },
      { name: 'Execution', status: 'BLOCKED', detail: 'No approved onchain mandate, funded strategy vault, live venue quote, transaction simulation or signer is connected.' },
    ],
    prices: state, quote: { source: 'synthetic-fixture', ...trade }, vault: { source: 'synthetic-fixture', exposureUsdcRaw: '0', address: null },
    policyDecision: reasons.length ? 'REJECT' : 'PRECHECK_PASS', reasons,
    execution: { authorized: false, status: 'NOT_SUBMITTED', transactionSignature: null, fundsMoved: false },
    note: 'This is a reproducible policy test record, not an onchain transaction receipt. A passing precheck never grants execution authority.',
  };
  return { ...record, recordHash: hashRecord(record) };
}

export function assessLiveEvidence(state: MarketState, mode: 'live' | 'sample') {
  const scan = scanConvergence(state, 50);
  return { source: mode === 'live' ? 'pyth-pro' : 'sample', state, scan,
    dataReady: mode === 'live' && state.markets.length === state.profile.symbols.length && state.markets.every(row => row.price && row.issues.length === 0),
    executionAuthorized: false,
    blockers: ['FINALIZED_STRATEGY_MANDATE_REQUIRED', 'FUNDED_ISOLATED_VAULT_REQUIRED', 'LIVE_VENUE_QUOTE_REQUIRED', 'TRANSACTION_SIMULATION_REQUIRED', 'RESTRICTED_SIGNER_REQUIRED', 'SETTLEMENT_AND_RETURN_PATH_REQUIRED'],
  };
}
