import test from "node:test";
import assert from "node:assert/strict";
import { canSubmitProposal } from "../apps/web/src/proposals/presentation.js";
import type { ProposalReviewView } from "../apps/web/src/proposals/types.js";
import { finalizeProposalReview, REQUIRED_PROPOSAL_CHECKS } from "../services/governance-mcp/src/review.js";

function validView(): ProposalReviewView {
  return {
    draftId: "draft-1", submissionSource: "AFTERHOURS_PORTAL", reviewStatus: "VALID",
    lifecycleState: "NOT_SUBMITTED", requestedByWallet: "wallet", observedProposalWeightRaw: "9007199254740994",
    requiredProposalWeightRaw: "9007199254740993", manifestHash: "abc", automationEligible: true,
    checks: [], issues: [],
  };
}

test("submission uses exact raw proposal weight, including values above JS safe integer", () => {
  const view = validView();
  assert.equal(canSubmitProposal(view), true);
  view.observedProposalWeightRaw = "9007199254740992";
  assert.equal(canSubmitProposal(view), false);
  view.observedProposalWeightRaw = "not-a-balance";
  assert.equal(canSubmitProposal(view), false);
});

test("deterministic review rejects insufficient proposal weight even when other checks pass", () => {
  const input = {
    draft: { actionable: true, kind: "CREATE_STRATEGY" as const,
      normalizedManifestHash: "abc", instructionProgramIds: ["program"], decodedEffects: ["effect"], issues: [] },
    checks: REQUIRED_PROPOSAL_CHECKS.map(id => ({ id, passed: true, message: "ok" })),
    reviewedAtSlot: 123, reviewedAtIso: "2026-09-24T00:00:00.000Z",
    requiredProposalWeightRaw: "9007199254740993", observedProposalWeightRaw: "9007199254740992",
  };
  const review = finalizeProposalReview(input);
  assert.equal(review.status, "INVALID");
  assert.ok(review.issues.some(issue => issue.code === "INSUFFICIENT_PROPOSAL_WEIGHT"));
  input.observedProposalWeightRaw = "9007199254740993";
  assert.equal(finalizeProposalReview(input).status, "VALID");
});
