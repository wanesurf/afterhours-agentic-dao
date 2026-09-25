export interface AgentAuditEvent {
  runId: string;
  occurredAt: string;
  type: "mandate-loaded" | "market-read" | "opportunity" | "policy-check" | "simulation" | "execution" | "halt";
  summary: string;
  evidence: Record<string, unknown>;
}

export interface AgentAuditLog {
  append(event: AgentAuditEvent): Promise<void>;
  list(runId: string): Promise<AgentAuditEvent[]>;
}
