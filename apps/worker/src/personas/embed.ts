// Task #46: persona embedding + semantic_fit lookup.
//
// We re-embed on every PATCH and upsert into the `axal-personas-768`
// Vectorize index. Account/buyer embeddings already live in
// VEC_ACCOUNTS / VEC_LEADS (see Task #44 / #25); semantic_fit is
// computed by querying VEC_ACCOUNTS with the persona vector and reading
// the cosine score. This keeps the cost down — one query per (persona,
// rescore) batch instead of N pair-wise dot products.

import type { Env } from "../types";
import { aiEmbed } from "../ai/extract";
import type { PersonaSpec } from "./score";
import { buildEmbeddingText } from "./score";

export async function embedPersona(env: Env, p: PersonaSpec & { id: string; name: string; thesis: string | null }): Promise<{ vector: number[] | null; text: string }> {
  const text = buildEmbeddingText(p);
  const vector = await aiEmbed(env, text);
  if (vector && env.VEC_PERSONAS) {
    try {
      await env.VEC_PERSONAS.upsert([{ id: p.id, values: vector, metadata: { name: p.name, kind: p.kind } }]);
    } catch (e) {
      console.warn("VEC_PERSONAS.upsert failed", (e as Error).message);
    }
  }
  return { vector, text };
}

export async function deletePersonaVector(env: Env, id: string): Promise<void> {
  if (!env.VEC_PERSONAS) return;
  try { await env.VEC_PERSONAS.deleteByIds([id]); } catch (e) { console.warn("VEC_PERSONAS.delete failed", (e as Error).message); }
}

// Returns { entityId -> cosine } for every account whose embedding is
// within the top `topK` of this persona's vector. Anything not in the
// map is treated as semantic_fit = null (component falls back to 50 in
// the scorer when the index is empty).
export async function topMatchesForPersona(env: Env, vector: number[], opts: { kind: "account"; topK: number }): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const idx = opts.kind === "account" ? env.VEC_ACCOUNTS : undefined;
  if (!idx) return out;
  try {
    const r = await idx.query(vector, { topK: Math.min(1000, Math.max(1, opts.topK)), returnMetadata: "none" });
    for (const m of r.matches ?? []) out.set(m.id, m.score);
  } catch (e) {
    console.warn("VEC_ACCOUNTS.query failed", (e as Error).message);
  }
  return out;
}

// Cosine similarity between two equal-length vectors. We assume both
// embeddings come from the same model (bge-base-en-v1.5, dim=768) so
// they live on the same unit sphere; we still normalize defensively.
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Fetch the existing entity vectors from VEC_ACCOUNTS (or VEC_BUYERS
// when wired) for `ids` and return { id -> cosine vs persona vector }.
// Used by the full-rescore loop so EVERY entity gets a real semantic_fit
// (not just the top-K of a single Vectorize.query call).
export async function cosinesForEntities(
  env: Env,
  personaVector: number[],
  opts: { kind: "account" | "buyer"; ids: string[] },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!opts.ids.length) return out;
  const idx = opts.kind === "account" ? env.VEC_ACCOUNTS : undefined;
  if (!idx) return out;
  // Vectorize getByIds caps at 100 ids per call.
  const CHUNK = 100;
  for (let i = 0; i < opts.ids.length; i += CHUNK) {
    const chunk = opts.ids.slice(i, i + CHUNK);
    try {
      const rows = await idx.getByIds(chunk);
      for (const v of rows ?? []) {
        const values = (v as { values?: number[] }).values;
        if (Array.isArray(values) && values.length) out.set(v.id, cosine(personaVector, values));
      }
    } catch (e) {
      console.warn("VEC_ACCOUNTS.getByIds failed", (e as Error).message);
    }
  }
  return out;
}
