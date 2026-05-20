// Fact insertion with content-addressed dedup. The DB trigger
// `trg_facts_supersede` flips the prior is_current=1 fact for the same
// (entity, predicate, source) to 0 after insert.

import type { Env } from "../types";
import type { FactInput } from "./model";
import { sha256 } from "./normalize";
import { enqueueSummaryRebuild } from "./summaryQueue";
// Task #8: triggers debounced persona ↔ entity re-match when a fact
// that materially affects scoring is written. No-op otherwise.
import { triggerEntityMatchRefresh, isRelevantPredicate } from "../services/personaMatchTrigger";

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
  // Task #3 (Editable Profiles): lock check. If a locked override exists
  // for this (entity, predicate), the new fact row is still inserted (so
  // the diff strip can show the AI/scrape attempt) but stamped with
  // superseded_by_override=1 so it never wins the read race. The override
  // layer overlays at read time via getEffectiveFacts.
  const lock = await env.DB.prepare(
    `SELECT 1 FROM field_overrides
      WHERE entity_id = ? AND predicate = ? AND locked = 1
        AND (unlock_after IS NULL OR unlock_after > datetime('now'))
      LIMIT 1`,
  ).bind(f.entity_id, f.predicate).first().catch(() => null);
  const supersededByOverride = lock ? 1 : 0;
  try {
    await env.DB.prepare(
      `INSERT INTO facts (
         id, entity_id, predicate, value_text, value_number, value_json,
         value_entity_id, source_kind, source, evidence_url, confidence,
         observed_at, valid_from, valid_to, is_current, hash, superseded_by_override
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
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
      supersededByOverride,
    ).run();
    // Task #3 race fix: the SELECT lock-check above and this INSERT are
    // not atomic. If an override landed between them, our row would have
    // superseded_by_override=0 even though an override now dominates. The
    // override-create handler ALSO runs `UPDATE facts SET
    // superseded_by_override = 1` to catch facts inserted before the
    // override; this post-insert re-check covers the reverse direction,
    // so both writers converge on the same end state regardless of which
    // raced first.
    if (!supersededByOverride) {
      await env.DB.prepare(
        `UPDATE facts SET superseded_by_override = 1
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM field_overrides
               WHERE entity_id = ? AND predicate = ? AND locked = 1
                 AND (unlock_after IS NULL OR unlock_after > datetime('now'))
            )`,
      ).bind(id, f.entity_id, f.predicate).run().catch(() => undefined);
    }
    // Centralized rebuild guarantee: every successful fact insert
    // enqueues a summary rebuild for the owning entity. This keeps the
    // "fact INSERT → rebuild within ~5s" SLO honest regardless of which
    // caller wrote the fact (dual-write, merge, manual admin, etc.).
    await enqueueSummaryRebuild(env, f.entity_id);
    if (isRelevantPredicate(f.predicate)) {
      // Fire-and-forget; debounced via KV inside the trigger.
      void triggerEntityMatchRefresh(env, f.entity_id).catch((e) => {
        console.warn("triggerEntityMatchRefresh from insertFact failed", (e as Error).message);
      });
    }
    // Task #4 (Relationship Inference Worker): debounced enqueue into
    // relationship_infer_queue (migration 377). KV-debounced 60s; the
    // consolidated nightly slot drains the queue with the per-entity
    // orchestrator pass. Never inline — entity/fact writes stay fast.
    // No `relationship_infer` JobKind exists, so we fall back to the
    // nightly tick per the spec's explicit instruction.
    try {
      const { enqueueRelInfer } = await import("../services/relationships/orchestrator");
      void enqueueRelInfer(env, f.entity_id, `fact:${f.predicate}`).catch(() => undefined);
    } catch { /* best-effort */ }
    return id;
  } catch (e) {
    // UNIQUE(hash) collision = exact-replay observation. Task #1
    // requires re-imports of the same Folk row to refresh `observed_at`
    // so freshness queries reflect when we last *saw* the fact, even
    // when nothing about the value changed. We update the existing row
    // (matched by hash) instead of writing a new one.
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) {
      try {
        await env.DB.prepare(
          "UPDATE facts SET observed_at = ? WHERE hash = ?",
        ).bind(now, hash).run();
      } catch (uErr) {
        console.warn("insertFact observed_at refresh failed", (uErr as Error).message);
      }
      return null;
    }
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

// Task #3 (Editable Profiles): single, shared overlay used by both the
// summary rebuild and the per-entity fact read path. The override row
// wins when locked=1 and the unlock_after window has not expired. The
// AI/scrape attempt is preserved in `facts` (with superseded_by_override=1
// set by insertFact) so the field-history diff strip can show it; this
// helper returns it ONLY in the array marked `overridden_attempt=true`
// for diff rendering — never as the canonical value.
export interface EffectiveFact {
  id: string;
  predicate: string;
  value_text: string | null;
  value_number: number | null;
  value_json: unknown;
  value_entity_id: string | null;
  source_kind: string;
  source: string | null;
  confidence: number;
  verified_score: number | null;
  observed_at: string;
  is_current: number;
  superseded_by_override: number;
  is_override: boolean;
  override_id: string | null;
  overridden_attempt: boolean;
}

interface FieldOverrideRow {
  id: string;
  predicate: string;
  value_text: string | null;
  value_numeric: number | null;
  value_json: string | null;
  overridden_at: string;
}

interface RawFactRow {
  id: string;
  predicate: string;
  value_text: string | null;
  value_number: number | null;
  value_json: string | null;
  value_entity_id: string | null;
  source_kind: string;
  source: string | null;
  confidence: number;
  verified_score: number | null;
  observed_at: string;
  is_current: number;
  superseded_by_override: number;
}

function parseJsonSafe(s: string | null): unknown {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}

export async function loadCurrentOverrides(env: Env, entityId: string): Promise<Map<string, FieldOverrideRow>> {
  const r = await env.DB.prepare(
    `SELECT id, predicate, value_text, value_numeric, value_json, overridden_at
       FROM field_overrides
      WHERE entity_id = ? AND locked = 1
        AND (unlock_after IS NULL OR unlock_after > datetime('now'))
      ORDER BY overridden_at DESC`,
  ).bind(entityId).all<FieldOverrideRow>().catch(() => ({ results: [] as FieldOverrideRow[] }));
  const map = new Map<string, FieldOverrideRow>();
  for (const o of r.results ?? []) {
    if (!map.has(o.predicate)) map.set(o.predicate, o);
  }
  return map;
}

export async function getEffectiveFacts(env: Env, entityId: string, opts?: { includeNonCurrent?: boolean; limit?: number }): Promise<EffectiveFact[]> {
  const factWhere = opts?.includeNonCurrent ? "" : " AND is_current = 1";
  const limit = opts?.limit ?? 500;
  const [factsRes, overrides] = await Promise.all([
    env.DB.prepare(
      `SELECT id, predicate, value_text, value_number, value_json, value_entity_id,
              source_kind, source, confidence, verified_score, observed_at,
              is_current, superseded_by_override
         FROM facts
        WHERE entity_id = ?${factWhere}
        ORDER BY observed_at DESC LIMIT ?`,
    ).bind(entityId, limit).all<RawFactRow>(),
    loadCurrentOverrides(env, entityId),
  ]);
  const out: EffectiveFact[] = [];
  const overridePredsSeen = new Set<string>();

  for (const f of factsRes.results ?? []) {
    const ov = overrides.get(f.predicate);
    if (ov) {
      if (!overridePredsSeen.has(f.predicate)) {
        overridePredsSeen.add(f.predicate);
        out.push({
          id: `override:${ov.id}`,
          predicate: f.predicate,
          value_text: ov.value_text,
          value_number: ov.value_numeric,
          value_json: parseJsonSafe(ov.value_json),
          value_entity_id: null,
          source_kind: "manual",
          source: "field_override",
          confidence: 1,
          verified_score: null,
          observed_at: ov.overridden_at,
          is_current: 1,
          superseded_by_override: 0,
          is_override: true,
          override_id: ov.id,
          overridden_attempt: false,
        });
      }
      // Mark the underlying fact as an overridden attempt for the diff
      // strip. Never returned as canonical.
      out.push({
        id: f.id,
        predicate: f.predicate,
        value_text: f.value_text,
        value_number: f.value_number,
        value_json: parseJsonSafe(f.value_json),
        value_entity_id: f.value_entity_id,
        source_kind: f.source_kind,
        source: f.source,
        confidence: f.confidence,
        verified_score: f.verified_score,
        observed_at: f.observed_at,
        is_current: f.is_current,
        superseded_by_override: 1,
        is_override: false,
        override_id: null,
        overridden_attempt: true,
      });
    } else if (f.superseded_by_override === 1) {
      out.push({
        id: f.id,
        predicate: f.predicate,
        value_text: f.value_text,
        value_number: f.value_number,
        value_json: parseJsonSafe(f.value_json),
        value_entity_id: f.value_entity_id,
        source_kind: f.source_kind,
        source: f.source,
        confidence: f.confidence,
        verified_score: f.verified_score,
        observed_at: f.observed_at,
        is_current: f.is_current,
        superseded_by_override: 1,
        is_override: false,
        override_id: null,
        overridden_attempt: true,
      });
    } else {
      out.push({
        id: f.id,
        predicate: f.predicate,
        value_text: f.value_text,
        value_number: f.value_number,
        value_json: parseJsonSafe(f.value_json),
        value_entity_id: f.value_entity_id,
        source_kind: f.source_kind,
        source: f.source,
        confidence: f.confidence,
        verified_score: f.verified_score,
        observed_at: f.observed_at,
        is_current: f.is_current,
        superseded_by_override: 0,
        is_override: false,
        override_id: null,
        overridden_attempt: false,
      });
    }
  }
  // Overrides for predicates with no underlying fact row at all.
  for (const [pred, ov] of overrides.entries()) {
    if (overridePredsSeen.has(pred)) continue;
    out.push({
      id: `override:${ov.id}`,
      predicate: pred,
      value_text: ov.value_text,
      value_number: ov.value_numeric,
      value_json: parseJsonSafe(ov.value_json),
      value_entity_id: null,
      source_kind: "manual",
      source: "field_override",
      confidence: 1,
      verified_score: null,
      observed_at: ov.overridden_at,
      is_current: 1,
      superseded_by_override: 0,
      is_override: true,
      override_id: ov.id,
      overridden_attempt: false,
    });
  }
  return out;
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
