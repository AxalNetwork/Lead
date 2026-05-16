// Analytics Engine event helpers (Task #25 step 7).
//
// Cloudflare Analytics Engine accepts up to 20 blobs (strings), 20 doubles,
// and 1 list of indexes per data point. We standardize the schema across all
// AI/fetch events so the GraphQL Analytics API queries stay simple.
//
// Schema:
//   indexes: [purpose] e.g. "extraction" | "embedding" | "arbitration" | …
//   blobs:   [purpose, model, host, cache_hit, job_id]
//   doubles: [neurons, ms, bytes, cost_usd]

import type { Env } from "../types";

export type AiPurpose =
  | "extraction"
  | "embedding"
  | "arbitration"
  | "normalization"
  | "bio_summary"
  | "persona_infer"
  | "ocr"
  | "email_classify"
  | "explanation"
  | "pitch"
  | "project_match"
  | "classify_types"
  | "classify_ideology"
  | "classify_interests"
  | "profile_summary";

export interface TrackAiArgs {
  purpose: AiPurpose;
  model: string;
  neurons?: number;
  ms?: number;
  cacheHit?: boolean;
  jobId?: string;
  costUsd?: number;
}

export function trackAi(env: Env, args: TrackAiArgs): void {
  const purpose = args.purpose;
  const cache = args.cacheHit ? "1" : "0";
  try {
    env.ANALYTICS?.writeDataPoint({
      indexes: [purpose],
      blobs: [purpose, args.model, "", cache, args.jobId ?? ""],
      doubles: [args.neurons ?? 0, args.ms ?? 0, 0, args.costUsd ?? 0],
    });
  } catch {
    /* analytics is best-effort */
  }
  // Also persist a daily roll-up to D1 so /api/analytics/ae/ai-cost works
  // without the GraphQL Analytics API (which requires an account-level token).
  if (!args.cacheHit) {
    void rollupAiCost(env, purpose, args.model, args.neurons ?? 0, args.costUsd ?? 0);
  }
}

export interface TrackFetchArgs {
  host: string;
  tier: number;
  status: number;
  ms: number;
  bytes: number;
  blockReason?: string | null;
}

export interface TrackVectorizeArgs {
  op: "query" | "upsert" | "delete";
  index: "leads" | "firms" | "companies";
}

// Vectorize ops are billed per query/upsert independent of AI neurons. We
// count them in the same ai_cost_daily roll-up under purpose='vectorize_<op>'
// so /api/scrapers/health can surface the daily burn against
// VECTORIZE_DAILY_QUERIES_CAP.
export function trackVectorize(env: Env, args: TrackVectorizeArgs): void {
  try {
    env.ANALYTICS?.writeDataPoint({
      indexes: [`vectorize_${args.op}`],
      blobs: [`vectorize_${args.op}`, args.index, "", "0", ""],
      doubles: [0, 0, 0, 0],
    });
  } catch { /* best-effort */ }
  void rollupVectorizeOp(env, args.op, args.index);
}

async function rollupVectorizeOp(env: Env, op: string, index: string): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO ai_cost_daily (day, purpose, model, neurons, cost_usd, calls)
       VALUES (?, ?, ?, 0, 0, 1)
       ON CONFLICT(day, purpose, model) DO UPDATE SET calls = calls + 1`,
    ).bind(day, `vectorize_${op}`, index).run();
  } catch (e) {
    console.warn("vectorize rollup failed", (e as Error).message);
  }
}

export function trackFetch(env: Env, args: TrackFetchArgs): void {
  try {
    env.ANALYTICS?.writeDataPoint({
      indexes: ["fetch"],
      blobs: ["fetch", String(args.tier), args.host, args.blockReason ?? "", String(args.status)],
      doubles: [0, args.ms, args.bytes, 0],
    });
  } catch { /* best-effort */ }
}

async function rollupAiCost(env: Env, purpose: string, model: string, neurons: number, costUsd: number): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO ai_cost_daily (day, purpose, model, neurons, cost_usd, calls)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(day, purpose, model) DO UPDATE SET
         neurons = neurons + excluded.neurons,
         cost_usd = cost_usd + excluded.cost_usd,
         calls = calls + 1`,
    ).bind(day, purpose, model, neurons, costUsd).run();
  } catch (e) {
    console.warn("ai_cost_daily rollup failed", (e as Error).message);
  }
}
