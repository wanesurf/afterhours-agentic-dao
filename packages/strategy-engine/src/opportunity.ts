export type OpportunityKind = "executable-arbitrage" | "price-dislocation";

export interface StrategyOpportunity {
  id: string;
  kind: OpportunityKind;
  buySymbol: string;
  sellSymbol: string;
  expectedNetProfitUsd: number;
  expectedNetProfitBps: number;
  expiresAtMs: number;
  evidence: Record<string, unknown>;
}
