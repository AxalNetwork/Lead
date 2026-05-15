// Vectorize-backed entity resolution (Task #25 step 3).
//
// Runs *after* the exact-key pre-filter in dedupe/index.ts when the
// VEC_LEADS / VEC_FIRMS / VEC_COMPANIES bindings are configured. Builds an
// embedding text from name+org+city+role+bio, queries top-K=5, arbitrates
// matches above 0.82 with an LLM yes/no/maybe call. Returns:
//   - { action: "merge", id }       → caller routes through DO lock
//   - { action: "review", id, … }   → caller writes dedupe_review row
//   - { action: "insert" }          → caller inserts new row + adds vector
//
// Vector upsert after a new insert is fire-and-forget (logged on failure).

import type { Env, VectorizeIndex } from "../types";
import { aiEmbed, aiArbitrate } from "../ai/extract";
import { assertBudget } from "../ai/budget";
import { trackVectorize } from "../analytics/events";

const SIM_AUTO_MERGE = 0.85;
const SIM_REVIEW = 0.82;

export type EntityKind = "leads" | "firms" | "companies";

export interface VectorMatchInput {
  name?: string | null;
  org?: string | null;
  city?: string | null;
  role?: string | null;
  bio?: string | null;
  email?: string | null;
}

export interface VectorDecision {
  action: "merge" | "review" | "insert";
  id?: string;
  score?: number;
  arbitration?: { match: "yes" | "no" | "maybe"; confidence: number };
  reasons?: string[];
}

function getIndex(env: Env, kind: EntityKind): VectorizeIndex | undefined {
  if (kind === "leads") return env.VEC_LEADS;
  if (kind === "firms") return env.VEC_FIRMS;
  return env.VEC_COMPANIES;
}

export function buildText(input: VectorMatchInput): string {
  return [
    input.name,
    input.role,
    input.org,
    input.city,
    input.email,
    (input.bio ?? "").slice(0, 200),
  ].filter(Boolean).join(" | ").trim();
}

export async function resolveByVector(
  env: Env,
  kind: EntityKind,
  input: VectorMatchInput,
): Promise<VectorDecision> {
  const idx = getIndex(env, kind);
  if (!idx) return { action: "insert" };
  const text = buildText(input);
  if (!text) return { action: "insert" };
  const vec = await aiEmbed(env, text);
  if (!vec) return { action: "insert" };

  // Vectorize budget gate: refuse to query past the daily cap so a runaway
  // loop can't drain the index. Counted via analytics/events trackVectorize.
  const ok = await assertBudget(env, "vectorize");
  if (!ok.ok) return { action: "insert" };

  let matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = [];
  try {
    const r = await idx.query(vec, { topK: 5, returnMetadata: "all" });
    matches = r.matches ?? [];
    trackVectorize(env, { op: "query", index: kind });
  } catch (e) {
    console.warn(`vectorize.${kind}.query failed`, (e as Error).message);
    return { action: "insert" };
  }
  if (!matches.length) return { action: "insert" };

  const best = matches[0];
  if (best.score >= SIM_AUTO_MERGE) {
    // Above-threshold direct match: still arbitrate to guard against
    // semantically-similar-but-distinct people (e.g. "John Smith @ Acme").
    const arb = await aiArbitrate(env, text, JSON.stringify(best.metadata ?? {}));
    if (arb.match === "yes" && arb.confidence >= 0.85) {
      return { action: "merge", id: best.id, score: best.score, arbitration: arb };
    }
    return { action: "review", id: best.id, score: best.score, arbitration: arb, reasons: ["vector_high_arb_unsure"] };
  }
  if (best.score >= SIM_REVIEW) {
    return { action: "review", id: best.id, score: best.score, reasons: ["vector_borderline"] };
  }
  return { action: "insert" };
}

export async function upsertEntityVector(
  env: Env,
  kind: EntityKind,
  id: string,
  input: VectorMatchInput,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const idx = getIndex(env, kind);
  if (!idx) return;
  const text = buildText(input);
  if (!text) return;
  const vec = await aiEmbed(env, text);
  if (!vec) return;
  const ok = await assertBudget(env, "vectorize");
  if (!ok.ok) return;
  try {
    await idx.upsert([{ id, values: vec, metadata: { ...metadata, name: input.name ?? "", org: input.org ?? "" } }]);
    trackVectorize(env, { op: "upsert", index: kind });
  } catch (e) {
    console.warn(`vectorize.${kind}.upsert failed`, (e as Error).message);
  }
}
