// Shared types for enrichment providers + orchestrator.

import type { Env } from "../types";
import type { Lead, LeadPatch } from "../db/leads.types";

export interface EnrichInput {
  lead: Lead;
}

export interface EnrichResult {
  patch: LeadPatch;
  evidence_url: string | null;
  cost_usd: number;
  ok: boolean;
  reason?: string; // when ok=false: "no_data" | "blocked" | "budget" | "missing_key" | "error" | "missing_input"
}

export interface Provider {
  name: string;
  // Default merge priority — higher number wins on conflict (paid > free).
  priority: number;
  isConfigured(env: Env): boolean;
  dailyCapUsd(env: Env): number;
  /**
   * True when the provider uses a free public API and always reports
   * `cost_usd: 0`. Free providers bypass the daily USD budget entirely.
   *
   * This exists because `checkBudget` treats a cap of 0 as "disabled" —
   * a deliberate kill switch for metered providers. Once every paid
   * provider was removed, the only two left were free, both defaulted to
   * a cap of 0, and so every enrichment call was refused with
   * reason:"budget". Capping spend that cannot happen is meaningless;
   * disable a free provider through `isConfigured` instead.
   */
  isFree?: boolean;
  enrich(env: Env, input: EnrichInput): Promise<EnrichResult>;
}

export function envFloat(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export function emptyResult(reason: EnrichResult["reason"]): EnrichResult {
  return { patch: {}, evidence_url: null, cost_usd: 0, ok: false, reason };
}
