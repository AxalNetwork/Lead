// Task #8: hallucination-flag persistence helper. Inserts a row into
// hallucination_flags WITHOUT touching the canonical `facts` ledger.
// Callers use guardedInsertFact() below as the single entry point so
// the verifier always runs before insertFact.

import type { Env } from "../../types";
import type { FactInput } from "../../entities/model";
import { insertFact } from "../../entities/facts";
import { verifySourceSpan, type VerifyResult } from "./verifier";

export interface HallucinationFlagInput {
  entity_id: string | null;
  predicate: string;
  claim_text: string;
  source_span: string | null;
  source_url?: string | null;
  source_kind?: string | null;
  extractor: string;
  prompt_version_id?: string | null;
  fail_reason: string;
  fuzzy_score?: number | null;
  raw_extraction?: unknown;
}

export async function recordHallucinationFlag(env: Env, input: HallucinationFlagInput): Promise<string | null> {
  try {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO hallucination_flags
         (id, entity_id, predicate, claim_text, source_span, source_url, source_kind,
          extractor, prompt_version_id, fail_reason, fuzzy_score, raw_extraction_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, input.entity_id, input.predicate, input.claim_text,
      input.source_span ?? null, input.source_url ?? null, input.source_kind ?? null,
      input.extractor, input.prompt_version_id ?? null,
      input.fail_reason, input.fuzzy_score ?? null,
      input.raw_extraction != null ? JSON.stringify(input.raw_extraction) : null,
    ).run();
    console.warn("hallucination_flag", {
      extractor: input.extractor, predicate: input.predicate, reason: input.fail_reason,
      fuzzy: input.fuzzy_score, entity_id: input.entity_id,
    });
    return id;
  } catch (e) {
    console.warn("recordHallucinationFlag failed", (e as Error).message);
    return null;
  }
}

export interface GuardedFactInput extends FactInput {
  /** The text the extractor cites as evidence. Required for AI-extracted facts. */
  source_span?: string | null;
  /** The full source text (page body / article body) the extractor read. */
  source_text?: string | null;
  /** Stable extractor name, e.g. 'deal_extractor:v1'. */
  extractor: string;
  /** Active prompt_versions.id when the extractor ran (for forensic linkage). */
  prompt_version_id?: string | null;
  /** Raw extraction payload, for forensic review. */
  raw_extraction?: unknown;
  /** Pre-computed claim text. Defaults to value_text / stringified value_number. */
  claim_text?: string;
}

/** AI-extractor entry point. Runs the verifier BEFORE insertFact; on
 *  failure writes to hallucination_flags and returns null so the
 *  canonical ledger never sees the fabricated row. */
export async function guardedInsertFact(env: Env, f: GuardedFactInput): Promise<{ id: string | null; flagged: boolean; result?: VerifyResult }> {
  if (!f.entity_id || !f.predicate) return { id: null, flagged: false };
  const claim = f.claim_text
    ?? (f.value_text != null ? String(f.value_text) : f.value_number != null ? String(f.value_number) : "");
  const sourceText = f.source_text ?? "";
  if (!claim.trim() || !sourceText.trim()) {
    // No source text supplied → cannot verify, fail closed for AI
    // extractors (the whole point is they must cite evidence).
    await recordHallucinationFlag(env, {
      entity_id: f.entity_id, predicate: f.predicate, claim_text: claim,
      source_span: f.source_span ?? null, source_url: f.evidence_url ?? null,
      source_kind: f.source_kind, extractor: f.extractor,
      prompt_version_id: f.prompt_version_id ?? null,
      fail_reason: !claim.trim() ? "claim_not_in_span" : "empty_span",
      fuzzy_score: 0, raw_extraction: f.raw_extraction,
    });
    return { id: null, flagged: true, result: { ok: false, reason: !claim.trim() ? "claim_not_in_span" : "empty_span" } };
  }
  const v = verifySourceSpan({ claim_text: claim, source_span: f.source_span ?? "", source_text: sourceText });
  if (!v.ok) {
    await recordHallucinationFlag(env, {
      entity_id: f.entity_id, predicate: f.predicate, claim_text: claim,
      source_span: f.source_span ?? null, source_url: f.evidence_url ?? null,
      source_kind: f.source_kind, extractor: f.extractor,
      prompt_version_id: f.prompt_version_id ?? null,
      fail_reason: v.reason ?? "low_fuzzy", fuzzy_score: v.fuzzy_score ?? null,
      raw_extraction: f.raw_extraction,
    });
    return { id: null, flagged: true, result: v };
  }
  const id = await insertFact(env, f);
  return { id, flagged: false, result: v };
}
