import type {
  ProposalReviewStatus,
  ProposalReviewView,
  RealmsProposalState,
} from "./types.js";

export interface StatusPresentation {
  label: string;
  description: string;
  tone: "neutral" | "progress" | "success" | "danger" | "warning";
}

export const REVIEW_STATUS_PRESENTATION: Record<
  ProposalReviewStatus,
  StatusPresentation
> = {
  PENDING: {
    label: "Pending review",
    description: "The proposal has not been checked yet.",
    tone: "neutral",
  },
  REVIEWING: {
    label: "Reviewing proposal",
    description: "The agent is explaining the proposal while deterministic checks run.",
    tone: "progress",
  },
  VALID: {
    label: "Valid — ready to submit",
    description: "All required checks passed. Review the effects before signing.",
    tone: "success",
  },
  INVALID: {
    label: "Invalid — changes required",
    description: "At least one required check failed. Resolve the listed issues.",
    tone: "danger",
  },
  STALE: {
    label: "Review expired",
    description: "Relevant chain state changed. Run the review again before signing.",
    tone: "warning",
  },
};

export const REALMS_STATE_LABELS: Record<RealmsProposalState, string> = {
  NOT_SUBMITTED: "Not submitted",
  DRAFT: "Submitted to Realms — draft",
  SIGNING_OFF: "Awaiting sign-off",
  VOTING: "Voting open",
  SUCCEEDED: "Passed — hold-up period",
  EXECUTABLE: "Passed — ready to execute",
  COMPLETED: "Executed",
  DEFEATED: "Defeated",
  CANCELLED: "Cancelled",
  EXECUTING_WITH_ERRORS: "Execution needs attention",
};

export function canSubmitProposal(review: ProposalReviewView): boolean {
  if (!/^(0|[1-9]\d*)$/.test(review.observedProposalWeightRaw) ||
      !/^(0|[1-9]\d*)$/.test(review.requiredProposalWeightRaw)) return false;
  return (
    review.reviewStatus === "VALID" &&
    review.lifecycleState === "NOT_SUBMITTED" &&
    review.automationEligible &&
    BigInt(review.observedProposalWeightRaw) >= BigInt(review.requiredProposalWeightRaw) &&
    review.manifestHash !== undefined
  );
}
