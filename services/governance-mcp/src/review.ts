import type {
  ProposalValidationIssue,
  ValidatedProposalDraft,
} from "./proposals.js";

export const REQUIRED_PROPOSAL_CHECKS = [
  "SCHEMA",
  "PROPOSAL_WEIGHT",
  "PROGRAM_ALLOWLIST",
  "POLICY_BOUNDS",
  "TREASURY_STATE",
  "ARTIFACTS",
  "INSTRUCTION_MATCH",
  "SIMULATION",
] as const;

export type ProposalCheckId = (typeof REQUIRED_PROPOSAL_CHECKS)[number];

export interface ProposalCheckResult {
  id: ProposalCheckId;
  passed: boolean;
  message: string;
}

export interface DeterministicProposalReview extends ValidatedProposalDraft {
  status: "VALID" | "INVALID";
  checks: readonly ProposalCheckResult[];
  reviewedAtSlot: number;
  reviewedAtIso: string;
  requiredProposalWeightRaw: string;
  observedProposalWeightRaw: string;
}

export interface FinalizeProposalReviewInput {
  draft: ValidatedProposalDraft;
  checks: readonly ProposalCheckResult[];
  reviewedAtSlot: number;
  reviewedAtIso: string;
  requiredProposalWeightRaw: string;
  observedProposalWeightRaw: string;
}

function parseRawWeight(value: string): bigint | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function missingCheckIssues(
  checks: readonly ProposalCheckResult[],
): ProposalValidationIssue[] {
  const seen = new Set(checks.map((check) => check.id));

  return REQUIRED_PROPOSAL_CHECKS.filter((id) => !seen.has(id)).map((id) => ({
    path: "review.checks",
    code: `MISSING_${id}`,
    message: `Required proposal check ${id} did not run.`,
  }));
}

export function finalizeProposalReview(
  input: FinalizeProposalReviewInput,
): DeterministicProposalReview {
  const missing = missingCheckIssues(input.checks);
  const failed = input.checks
    .filter((check) => !check.passed)
    .map<ProposalValidationIssue>((check) => ({
      path: "review.checks",
      code: `FAILED_${check.id}`,
      message: check.message,
    }));
  const requiredWeight = parseRawWeight(input.requiredProposalWeightRaw);
  const observedWeight = parseRawWeight(input.observedProposalWeightRaw);
  const weightIssues: ProposalValidationIssue[] = [];
  if (requiredWeight === null || observedWeight === null) {
    weightIssues.push({ path: "proposalWeight", code: "INVALID_PROPOSAL_WEIGHT", message: "Proposal weight must be a non-negative raw integer." });
  } else if (observedWeight < requiredWeight) {
    weightIssues.push({ path: "proposalWeight", code: "INSUFFICIENT_PROPOSAL_WEIGHT", message: "Wallet does not meet the Realm proposal threshold." });
  }
  const issues = [...input.draft.issues, ...missing, ...failed, ...weightIssues];
  const valid =
    input.draft.actionable &&
    Boolean(input.draft.normalizedManifestHash) &&
    issues.length === 0;

  return {
    ...input.draft,
    actionable: valid,
    status: valid ? "VALID" : "INVALID",
    checks: input.checks,
    issues,
    reviewedAtSlot: input.reviewedAtSlot,
    reviewedAtIso: input.reviewedAtIso,
    requiredProposalWeightRaw: input.requiredProposalWeightRaw,
    observedProposalWeightRaw: input.observedProposalWeightRaw,
  };
}
