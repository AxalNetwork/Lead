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
