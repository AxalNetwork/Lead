// Fact insertion with content-addressed dedup. The DB trigger
// `trg_facts_supersede` flips the prior is_current=1 fact for the same
// (entity, predicate, source) to 0 after insert.

import type { Env } from "../types";
import type { FactInput } from "./model";
import { sha256 } from "./normalize";

export async function insertFact(env: Env, f: FactInput): Promise<string | null> {
  if (!f.entity_id || !f.predicate) return null;
  const valueKey = JSON.stringify({
    t: f.value_text ?? null,
    n: f.value_number ?? null,
    j: f.value_json ?? null,
    e: f.value_entity_id ?? null,
  });
  const hash = await sha256(`${f.entity_id}|${f.predicate}|${valueKey}|${f.source ?? ""}`);
  const id = crypto.randomUUID();
  const now = f.observed_at ?? new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO facts (
         id, entity_id, predicate, value_text, value_number, value_json,
         value_entity_id, source_kind, source, evidence_url, confidence,
         observed_at, valid_from, valid_to, is_current, hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).bind(
      id, f.entity_id, f.predicate,
      f.value_text ?? null,
      f.value_number ?? null,
      f.value_json != null ? JSON.stringify(f.value_json) : null,
      f.value_entity_id ?? null,
      f.source_kind,
      f.source ?? null,
      f.evidence_url ?? null,
      f.confidence ?? 1,
      now,
      f.valid_from ?? null,
      f.valid_to ?? null,
      hash,
    ).run();
    return id;
  } catch (e) {
    // UNIQUE(hash) collision = exact-replay observation; ignore.
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) return null;
    throw e;
  }
}

export interface FactPatch {
  predicate: string;
  value_text?: string | null;
  value_number?: number | null;
  value_json?: unknown;
  value_entity_id?: string | null;
}

export async function insertFactsBatch(
  env: Env,
  entityId: string,
  patches: FactPatch[],
  source: string,
  sourceKind: FactInput["source_kind"] = "scrape",
  evidenceUrl: string | null = null,
): Promise<number> {
  let n = 0;
  for (const p of patches) {
    if (p.value_text == null && p.value_number == null && p.value_json == null && p.value_entity_id == null) continue;
    const id = await insertFact(env, {
      entity_id: entityId,
      predicate: p.predicate,
      value_text: p.value_text ?? null,
      value_number: p.value_number ?? null,
      value_json: p.value_json,
      value_entity_id: p.value_entity_id ?? null,
      source_kind: sourceKind,
      source,
      evidence_url: evidenceUrl,
    });
    if (id) n += 1;
  }
  return n;
}
