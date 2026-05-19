import type { Env } from "../../types";

export type VerificationStatus = "confirmed" | "contradicted" | "unverifiable" | "skipped";

export interface Claim {
  predicate: string;
  value_hash: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface VerifierResult {
  status: VerificationStatus;
  confidence: number;
  evidence_snippet?: string | null;
  evidence_url?: string | null;
  sources?: string[];
  reason?: string | null;
  derived_predicate?: string | null;
  derived_value_text?: string | null;
  derived_value_json?: unknown;
}

export interface Verifier {
  name: string;
  version: string;
  supports(claim: Claim): boolean;
  verify(env: Env, personEntityId: string, claim: Claim): Promise<VerifierResult>;
}
