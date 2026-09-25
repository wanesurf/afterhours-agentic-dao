export interface AgentRunRequest {
  mandateId: string;
  strategyId: string;
  reason: "schedule" | "market-event" | "manual-review";
}

export interface AgentRunResult {
  runId: string;
  status: "completed" | "rejected" | "failed";
  receiptIds: string[];
  summary: string;
}

export interface HostedHermesRuntime {
  startRun(request: AgentRunRequest): Promise<AgentRunResult>;
  cancelRun(runId: string): Promise<void>;
}
