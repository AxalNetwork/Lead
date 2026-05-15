// AI / Vectorize daily budget caps (Task #25 step 10).
//
// Reads AI_DAILY_NEURONS_CAP and VECTORIZE_DAILY_QUERIES_CAP from env vars.
// Polls the D1 ai_cost_daily roll-up (cached 60s in KV) for the running
// total; refuses calls past the cap so a runaway loop can't drain the
// account. /api/scrapers/health surfaces burn-down for the dashboard.

import type { Env } from "../types";

const KV_KEY = "ai-budget:today";
const CACHE_TTL = 60;

export interface BudgetSnapshot {
  day: string;
  neurons_used: number;
  neurons_cap: number;
  vectorize_used: number;
  vectorize_cap: number;
  cost_usd: number;
}

export async function getBurn(env: Env): Promise<BudgetSnapshot> {
  const cached = await env.SCRAPE_CACHE?.get(KV_KEY);
  if (cached) {
    try { return JSON.parse(cached) as BudgetSnapshot; } catch { /* fall through */ }
  }
  const day = new Date().toISOString().slice(0, 10);
  const totals = await env.DB.prepare(
    `SELECT
       SUM(neurons) AS neurons,
       SUM(cost_usd) AS cost,
       SUM(CASE WHEN purpose LIKE 'vectorize_%' THEN calls ELSE 0 END) AS vec_calls
     FROM ai_cost_daily WHERE day = ?`,
  ).bind(day).first<{ neurons: number | null; cost: number | null; vec_calls: number | null }>().catch(() => null);

  const snap: BudgetSnapshot = {
    day,
    neurons_used: Number(totals?.neurons ?? 0),
    neurons_cap: Number(env.AI_DAILY_NEURONS_CAP ?? "0") || 0,
    vectorize_used: Number(totals?.vec_calls ?? 0),
    vectorize_cap: Number(env.VECTORIZE_DAILY_QUERIES_CAP ?? "0") || 0,
    cost_usd: Number(totals?.cost ?? 0),
  };
  try {
    await env.SCRAPE_CACHE?.put(KV_KEY, JSON.stringify(snap), { expirationTtl: CACHE_TTL });
  } catch { /* best-effort */ }
  return snap;
}

export async function assertBudget(env: Env, kind: "ai" | "vectorize"): Promise<{ ok: boolean; reason?: string }> {
  const snap = await getBurn(env);
  if (kind === "ai" && snap.neurons_cap > 0 && snap.neurons_used >= snap.neurons_cap) {
    return { ok: false, reason: `neurons_cap_reached:${snap.neurons_used}/${snap.neurons_cap}` };
  }
  if (kind === "vectorize" && snap.vectorize_cap > 0 && snap.vectorize_used >= snap.vectorize_cap) {
    return { ok: false, reason: `vectorize_cap_reached:${snap.vectorize_used}/${snap.vectorize_cap}` };
  }
  return { ok: true };
}
