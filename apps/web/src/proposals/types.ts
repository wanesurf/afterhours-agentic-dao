export const PROPOSAL_REVIEW_STATUSES = [
  "PENDING",
  "REVIEWING",
  "VALID",
  "INVALID",
  "STALE",
] as const;

export type ProposalReviewStatus =
  (typeof PROPOSAL_REVIEW_STATUSES)[number];

export const REALMS_PROPOSAL_STATES = [
  "NOT_SUBMITTED",
  "DRAFT",
  "SIGNING_OFF",
  "VOTING",
  "SUCCEEDED",
  "EXECUTABLE",
  "COMPLETED",
  "DEFEATED",
  "CANCELLED",
  "EXECUTING_WITH_ERRORS",
] as const;

export type RealmsProposalState = (typeof REALMS_PROPOSAL_STATES)[number];

export interface ProposalReviewIssue {
  code: string;
  field?: string;
  message: string;
  suggestedFix?: string;
}

export interface ProposalReviewCheck {
  id: string;
  label: string;
  outcome: "PASS" | "FAIL";
  source: "SCHEMA" | "ELIGIBILITY" | "POLICY" | "ONCHAIN" | "SIMULATION";
}

export type ProposalSubmissionSource =
  | "AFTERHOURS_PORTAL"
  | "REALMS_EXTERNAL";

export interface ProposalReviewView {
  draftId: string;
  submissionSource: ProposalSubmissionSource;
  reviewStatus: ProposalReviewStatus;
  lifecycleState: RealmsProposalState;
  requestedByWallet: string;
  observedProposalWeightRaw: string;
  requiredProposalWeightRaw: string;
  summary?: string;
  manifestHash?: string;
  proposalAddress?: string;
  reviewedAt?: string;
  reviewedAtSlot?: number;
  automationEligible: boolean;
  checks: readonly ProposalReviewCheck[];
  issues: readonly ProposalReviewIssue[];
}
