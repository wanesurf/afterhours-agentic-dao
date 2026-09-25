export const ACTIONABLE_PROPOSAL_KINDS = [
  "CREATE_STRATEGY",
  "UPDATE_STRATEGY",
  "PAUSE_STRATEGY",
  "RESUME_STRATEGY",
  "FUND_STRATEGY_VAULT",
  "CLOSE_STRATEGY",
  "AUTHORIZE_MCP_VERSION",
  "AUTHORIZE_RUNTIME_BUILD",
] as const;

export type ActionableProposalKind =
  (typeof ACTIONABLE_PROPOSAL_KINDS)[number];

export type PublicKeyString = string;

export interface StrategyRiskLimits {
  maxAllocationRaw: string;
  maxTradeRaw: string;
  maxSlippageBps: number;
  maxDailyLossRaw: string;
  minNetEdgeBps: number;
  maxPriceAgeSeconds: number;
  maxConfidenceBps: number;
}

export interface StrategyMandateDraft {
  schemaVersion: 1;
  kind: Extract<
    ActionableProposalKind,
    | "CREATE_STRATEGY"
    | "UPDATE_STRATEGY"
    | "PAUSE_STRATEGY"
    | "RESUME_STRATEGY"
    | "CLOSE_STRATEGY"
  >;
  strategyId: string;
  strategyVersion: number;
  assets: readonly string[];
  venues: readonly string[];
  allowedMcpArtifactHashes: readonly string[];
  allowedRuntimeBuildHash: string;
  startsAtUnixSeconds: number;
  expiresAtUnixSeconds: number;
  risk: StrategyRiskLimits;
  rationale: string;
}

export interface ProposalValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidatedProposalDraft {
  actionable: boolean;
  kind?: ActionableProposalKind;
  normalizedManifestHash?: string;
  instructionProgramIds: readonly PublicKeyString[];
  decodedEffects: readonly string[];
  issues: readonly ProposalValidationIssue[];
}

export function isActionableProposalKind(
  value: string,
): value is ActionableProposalKind {
  return (ACTIONABLE_PROPOSAL_KINDS as readonly string[]).includes(value);
}
