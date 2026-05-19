// Task #13: Document persist layer.
//
// Single writer for `documents` / `document_extractions`. Mirrors
// every derived business-key fact (safe.cap, deal_terms.*, sha.*,
// commercial.acv_usd) onto the target entity via `insertFact` per
// the Task #1 canonical write contract — never directly into the
// facts table.
//
// Extraction rows are immutable per (document_id, extractor_name,
// extractor_version). A new version writes a new row; the latest
// row wins for read-time joins.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import type { ExtractorEnvelope } from "./extractorRouter";
import type { DocumentKind } from "./classifier";

export interface DocumentRow {
  id: string;
  owner_email: string;
  target_entity_id: string | null;
  filename: string;
  mime: string | null;
  size_bytes: number;
  r2_key: string;
  sha256: string | null;
  detected_kind: string | null;
  classifier_confidence: number | null;
  ocr_status: string;
  extraction_status: string;
  extraction_error: string | null;
  allow_raw_text: number;
  page_count: number | null;
  created_at: string;
  updated_at: string;
}

export async function persistExtraction(
  env: Env,
  documentId: string,
  targetEntityId: string | null,
  evidenceUrl: string,
  envelope: ExtractorEnvelope,
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO document_extractions (
         id, document_id, kind, extractor_name, extractor_version, confidence,
         payload_json, redaction_applied, redaction_counts_json, warnings_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, documentId, envelope.kind, envelope.extractor_name, envelope.extractor_version,
      envelope.confidence, JSON.stringify(envelope.payload),
      envelope.redaction_applied ? 1 : 0,
      envelope.redaction_counts ? JSON.stringify(envelope.redaction_counts) : null,
      envelope.warnings.length ? JSON.stringify(envelope.warnings) : null,
    ).run();
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) {
      // Same (document, extractor_name, version) re-run — no-op.
      return null;
    }
    throw e;
  }
  if (targetEntityId) {
    await mirrorDerivedFacts(env, targetEntityId, evidenceUrl, envelope);
  }
  return id;
}

/** Mirror per-kind business facts onto the target entity via insertFact.
 *  All writes go through insertFact (Task #1 contract). */
async function mirrorDerivedFacts(
  env: Env, entityId: string, evidenceUrl: string, env_: ExtractorEnvelope,
): Promise<void> {
  const ctx = {
    entity_id: entityId,
    source_kind: "import" as const,
    source: `document:${env_.extractor_name}`,
    evidence_url: evidenceUrl,
    confidence: env_.confidence,
  };
  switch (env_.kind) {
    case "safe": {
      const p = env_.payload as import("./extractors/safe").SafeExtraction;
      if (p.valuation_cap_usd != null) await insertFact(env, { ...ctx, predicate: "safe.cap_usd", value_number: p.valuation_cap_usd });
      if (p.discount_pct != null) await insertFact(env, { ...ctx, predicate: "safe.discount_pct", value_number: p.discount_pct });
      if (p.purchase_amount_usd != null) await insertFact(env, { ...ctx, predicate: "safe.purchase_amount_usd", value_number: p.purchase_amount_usd });
      if (p.variant !== "unknown") await insertFact(env, { ...ctx, predicate: "safe.variant", value_text: p.variant });
      if (p.mfn) await insertFact(env, { ...ctx, predicate: "safe.mfn", value_text: "true" });
      break;
    }
    case "term_sheet": {
      const p = env_.payload as import("./extractors/termSheet").TermSheetExtraction;
      if (p.pre_money_usd != null) await insertFact(env, { ...ctx, predicate: "deal_terms.pre_money_usd", value_number: p.pre_money_usd });
      if (p.post_money_usd != null) await insertFact(env, { ...ctx, predicate: "deal_terms.post_money_usd", value_number: p.post_money_usd });
      if (p.raise_amount_usd != null) await insertFact(env, { ...ctx, predicate: "deal_terms.raise_amount_usd", value_number: p.raise_amount_usd });
      if (p.security_type) await insertFact(env, { ...ctx, predicate: "deal_terms.security_type", value_text: p.security_type });
      if (p.liquidation_preference_x != null) await insertFact(env, { ...ctx, predicate: "deal_terms.liquidation_preference_x", value_number: p.liquidation_preference_x });
      if (p.anti_dilution) await insertFact(env, { ...ctx, predicate: "deal_terms.anti_dilution", value_text: p.anti_dilution });
      if (p.option_pool_target_pct != null) await insertFact(env, { ...ctx, predicate: "deal_terms.option_pool_target_pct", value_number: p.option_pool_target_pct });
      break;
    }
    case "shareholder_agreement": {
      const p = env_.payload as import("./extractors/sha").ShaExtraction;
      if (p.drag_along_threshold_pct != null) await insertFact(env, { ...ctx, predicate: "sha.drag_along_threshold_pct", value_number: p.drag_along_threshold_pct });
      if (p.tag_along) await insertFact(env, { ...ctx, predicate: "sha.tag_along", value_text: "true" });
      if (p.rofr) await insertFact(env, { ...ctx, predicate: "sha.rofr", value_text: "true" });
      if (p.preemptive_right) await insertFact(env, { ...ctx, predicate: "sha.preemptive_right", value_text: "true" });
      if (p.board_size != null) await insertFact(env, { ...ctx, predicate: "sha.board_size", value_number: p.board_size });
      break;
    }
    case "commercial_contract": {
      const p = env_.payload as import("./extractors/commercial").CommercialExtraction;
      if (p.acv_usd != null) await insertFact(env, { ...ctx, predicate: "commercial.acv_usd", value_number: p.acv_usd });
      if (p.tcv_usd != null) await insertFact(env, { ...ctx, predicate: "commercial.tcv_usd", value_number: p.tcv_usd });
      if (p.term_months != null) await insertFact(env, { ...ctx, predicate: "commercial.term_months", value_number: p.term_months });
      if (p.auto_renew) await insertFact(env, { ...ctx, predicate: "commercial.auto_renew", value_text: "true" });
      break;
    }
    case "pitch_deck": {
      const p = env_.payload as import("./extractors/pitchDeck").PitchDeckExtraction;
      if (p.tam_usd != null) await insertFact(env, { ...ctx, predicate: "deck.tam_usd", value_number: p.tam_usd });
      if (p.ask_amount_usd != null) await insertFact(env, { ...ctx, predicate: "deck.ask_amount_usd", value_number: p.ask_amount_usd });
      if (p.one_liner) await insertFact(env, { ...ctx, predicate: "deck.one_liner", value_text: p.one_liner });
      break;
    }
    case "financial_model": {
      const p = env_.payload as import("./extractors/financialModel").FinancialModelExtraction;
      const latestArr = p.arr_ramp_usd.length ? p.arr_ramp_usd[p.arr_ramp_usd.length - 1] : null;
      if (latestArr) await insertFact(env, {
        ...ctx, predicate: "model.latest_arr_usd", value_number: latestArr.arr_usd,
        value_json: { period: latestArr.period },
      });
      const latestBurn = p.burn_by_period_usd.length ? p.burn_by_period_usd[p.burn_by_period_usd.length - 1] : null;
      if (latestBurn) await insertFact(env, {
        ...ctx, predicate: "model.latest_burn_usd", value_number: latestBurn.burn_usd,
        value_json: { period: latestBurn.period },
      });
      break;
    }
    case "nda":
    case "unknown":
    default:
      // No business facts to mirror for NDAs / unknown.
      break;
  }
}

export function categorizeForDataRoom(kind: DocumentKind | string, filename: string): string {
  const f = filename.toLowerCase();
  switch (kind) {
    case "safe":
    case "term_sheet":
    case "shareholder_agreement":
      return "corporate";
    case "financial_model":
      return "financial";
    case "commercial_contract":
      return "customer";
    case "nda":
      return f.includes("employee") || f.includes("employment") ? "employment" : "regulatory";
    case "pitch_deck":
      return "corporate";
    default:
      if (/patent|trademark|copyright/.test(f)) return "ip";
      if (/employ|offer[_\s-]*letter|payroll/.test(f)) return "employment";
      return "other";
  }
}
