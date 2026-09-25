export const GOVERNANCE_EVENT_TYPES = [
  "PROPOSAL_CREATED",
  "PROPOSAL_VOTING",
  "PROPOSAL_SUCCEEDED",
  "PROPOSAL_EXECUTABLE",
  "PROPOSAL_EXECUTED",
  "PROPOSAL_DEFEATED_OR_CANCELLED",
] as const;

export type GovernanceEventType = (typeof GOVERNANCE_EVENT_TYPES)[number];

export interface GovernanceEvent {
  eventType: GovernanceEventType;
  realmAddress: string;
  governanceAddress: string;
  proposalAddress: string;
  proposalTransactionAddresses: readonly string[];
  observedSlot: number;
  finalized: boolean;
  transactionVersion: number;
}

export function governanceEventId(event: GovernanceEvent): string {
  return [
    event.proposalAddress,
    event.eventType,
    event.transactionVersion,
    event.observedSlot,
  ].join(":");
}

export function shouldWakeAgent(event: GovernanceEvent): boolean {
  return event.finalized;
}

export function requiresExecutionReview(event: GovernanceEvent): boolean {
  return event.finalized && event.eventType === "PROPOSAL_EXECUTABLE";
}
