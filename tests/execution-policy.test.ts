import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTrade,
  type ProposedTrade,
  type StrategyMandate,
  type StrategyState,
} from "../services/execution-mcp/src/policy.js";

const now = 1_790_000_000_000;

function fixture(): { mandate: StrategyMandate; trade: ProposedTrade; state: StrategyState } {
  return {
    mandate: {
      id: "realm-mandate-1",
      activeFromMs: now - 60_000,
      expiresAtMs: now + 60_000,
      allowedSymbols: ["Crypto.AAPLX/USD"],
      allowedVenues: ["meteora-dlmm"],
      maximumTradeUsd: 1_000,
      maximumStrategyExposureUsd: 5_000,
      maximumSlippageBps: 75,
      minimumNetProfitBps: 20,
      maximumQuoteAgeMs: 5_000,
      emergencyPaused: false,
    },
    trade: {
      symbol: "Crypto.AAPLX/USD",
      venue: "meteora-dlmm",
      notionalUsd: 500,
      estimatedSlippageBps: 20,
      expectedNetProfitBps: 40,
      quotedAtMs: now - 1_000,
      quoteExpiresAtMs: now + 1_000,
    },
    state: { exposureUsd: 4_000 },
  };
}

test("valid mandate, fresh quote, and vault exposure pass preflight", () => {
  const { mandate, trade, state } = fixture();
  assert.deepEqual(validateTrade(mandate, trade, state, now), []);
});

test("pause, approval, and each risk threshold fail closed", () => {
  const { mandate, trade, state } = fixture();
  mandate.emergencyPaused = true;
  trade.symbol = "Crypto.AAPLON/USD";
  trade.venue = "unknown-dex";
  trade.notionalUsd = 1_001;
  trade.estimatedSlippageBps = 76;
  trade.expectedNetProfitBps = 19;
  state.exposureUsd = 4_500;
  const failures = validateTrade(mandate, trade, state, now);
  assert.ok(failures.includes("strategy is paused"));
  assert.ok(failures.includes("symbol is not approved"));
  assert.ok(failures.includes("venue is not approved"));
  assert.ok(failures.includes("trade exceeds maximum size"));
  assert.ok(failures.includes("strategy exposure exceeds limit"));
  assert.ok(failures.includes("slippage exceeds limit"));
  assert.ok(failures.includes("expected profit is below threshold"));
});

test("rejects expired, aged, and future quotes", () => {
  const { mandate, trade, state } = fixture();
  trade.quotedAtMs = now - 5_001;
  assert.ok(validateTrade(mandate, trade, state, now).includes("quote is stale or invalid"));
  trade.quotedAtMs = now - 1_000;
  trade.quoteExpiresAtMs = now;
  assert.ok(validateTrade(mandate, trade, state, now).includes("quote is stale or invalid"));
  trade.quotedAtMs = now + 1;
  trade.quoteExpiresAtMs = now + 2;
  assert.ok(validateTrade(mandate, trade, state, now).includes("quote is stale or invalid"));
});

test("invalid numeric values and unsafe mandate quote windows fail closed", () => {
  const { mandate, trade, state } = fixture();
  trade.notionalUsd = Number.NaN;
  trade.estimatedSlippageBps = -1;
  trade.expectedNetProfitBps = Number.POSITIVE_INFINITY;
  state.exposureUsd = -1;
  mandate.maximumQuoteAgeMs = 30_000;
  const failures = validateTrade(mandate, trade, state, now);
  assert.ok(failures.includes("invalid trade size"));
  assert.ok(failures.includes("invalid slippage estimate"));
  assert.ok(failures.includes("invalid expected profit"));
  assert.ok(failures.includes("invalid vault exposure"));
  assert.ok(failures.includes("invalid mandate limits"));
});
