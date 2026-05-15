// Task #47: project embedding + per-audience semantic candidate fetch.

import type { Env, VectorizeIndex } from "../types";
import { aiEmbed } from "../ai/extract";
import type { Audience, ProjectSpec } from "./score";
import { buildEmbeddingText, AUDIENCE_KINDS } from "./score";

export async function embedProject(env: Env, p: ProjectSpec): Promise<{ vector: number[] | null; text: string }> {
  const text = buildEmbeddingText(p);
  const vector = await aiEmbed(env, text);
  if (vector && env.VEC_PROJECTS) {
    try {
      await env.VEC_PROJECTS.upsert([{ id: p.id, values: vector, metadata: { name: p.name } }]);
    } catch (e) {
      console.warn("VEC_PROJECTS.upsert failed", (e as Error).message);
    }
  }
  return { vector, text };
}

export async function deleteProjectVector(env: Env, id: string): Promise<void> {
  if (!env.VEC_PROJECTS) return;
  try { await env.VEC_PROJECTS.deleteByIds([id]); } catch (e) { console.warn("VEC_PROJECTS.delete failed", (e as Error).message); }
}

function indexFor(env: Env, kind: string): VectorizeIndex | undefined {
  switch (kind) {
    case "account": return env.VEC_ACCOUNTS;
    case "lead":    return env.VEC_LEADS;
    case "firm":    return env.VEC_FIRMS;
    case "company": return env.VEC_COMPANIES;
    default:        return undefined;
  }
}

export interface SemanticHit {
  entity_kind: "account" | "lead" | "firm" | "company";
  entity_id: string;
  cosine: number;
}

// Returns up to `topK` semantic hits across the audience's candidate
// indexes. Each index is queried independently; absent bindings are
// silently skipped (dev path / pre-provisioning).
export async function semanticCandidatesForAudience(
  env: Env,
  audience: Audience,
  vector: number[],
  topK = 100,
): Promise<SemanticHit[]> {
  const out: SemanticHit[] = [];
  const kinds = AUDIENCE_KINDS[audience].filter((k): k is "account" | "lead" | "firm" | "company" => k !== "buyer");
  for (const kind of kinds) {
    const idx = indexFor(env, kind);
    if (!idx) continue;
    try {
      const r = await idx.query(vector, { topK, returnMetadata: "none" });
      for (const m of r.matches ?? []) out.push({ entity_kind: kind, entity_id: m.id, cosine: m.score });
    } catch (e) {
      console.warn(`VEC ${kind}.query failed`, (e as Error).message);
    }
  }
  return out;
}
