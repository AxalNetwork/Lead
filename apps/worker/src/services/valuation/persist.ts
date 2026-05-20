// Task #9: Valuation marks persist layer.
//
// Single writer for `valuation_marks`. Marks are IMMUTABLE — a new
// observation at a different `as_of` writes a new row; the same source
// landing twice short-circuits on the dedupe_key UNIQUE constraint.
//
// On every successful insert we mirror facts on the company entity
// via `insertFact` (Task #1 canonical write):
//   - valuation.mark            (one fact per mark)
//   - valuation.latest_post_money_usd (only for primary_round / markdown)
//   - valuation.latest_secondary_usd  (only for secondary_listing)

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { createEntity, addRole } from "../../entities/roles";
import { normalizeCompanyName } from "../deals/dedupe";
import { sha256 } from "../../entities/normalize";
import { SOURCE_CONFIDENCE } from "./types";
import type { ValuationMarkInput, ValuationMarkPersistResult } from "./types";

const SOURCE_TAG = "valuation_marks";

async function findCompanyEntity(env: Env, c: ValuationMarkInput): Promise<string | null> {
  if (c.company_entity_id) return c.company_entity_id;
  const normalized = normalizeCompanyName(c.company_name_raw);
  if (!normalized) return null;
  const r = await env.DB.prepare(
    `SELECT entity_id FROM facts
      WHERE predicate = 'company.name_normalized' AND value_text = ? AND is_current = 1
      LIMIT 1`,
  ).bind(normalized).first<{ entity_id: string }>();
  return r?.entity_id ?? null;
}

async function ensureCompanyEntity(env: Env, c: ValuationMarkInput): Promise<string | null> {
  const existing = await findCompanyEntity(env, c);
  if (existing) return existing;
  if (!c.company_name_raw || c.company_name_raw.trim().length < 2) return null;
  const row = await createEntity(env, {
    kind: "org",
    display_name: c.company_name_raw.slice(0, 200),
    primary_url: null,
    primary_domain: null,
    suppressAutoProfileFill: true,
  });
  if (!row) return null; // Task #9: rejected by garbage detector
  await addRole(env, row.id, "company", { is_primary: true, source: SOURCE_TAG, confidence: 0.6 });
  const normalized = normalizeCompanyName(c.company_name_raw);
  if (normalized) {
    await insertFact(env, {
      entity_id: row.id, predicate: "company.name_normalized", value_text: normalized,
      source_kind: "scrape", source: SOURCE_TAG,
      evidence_url: c.source_url ?? null, confidence: 0.6,
    });
  }
  return row.id;
}

export async function markDedupeKey(c: ValuationMarkInput, entityId: string): Promise<string> {
  const parts = [
    entityId,
    c.source_kind,
    c.as_of,
    c.source_url ?? "",
    c.source_ref ?? "",
    c.holder_name_raw ?? "",
  ];
  return await sha256(parts.join("|"));
}

export async function persistValuationMark(
  env: Env, c: ValuationMarkInput,
): Promise<ValuationMarkPersistResult> {
  if (!c.as_of || !/^\d{4}-\d{2}-\d{2}$/.test(c.as_of)) {
    return { mark_id: null, company_entity_id: null, skipped: true, reason: "bad_as_of" };
  }
  if (c.implied_valuation_usd == null && c.share_price_usd == null) {
    return { mark_id: null, company_entity_id: null, skipped: true, reason: "no_valuation_signal" };
  }
  const entityId = await ensureCompanyEntity(env, c);
  if (!entityId) {
    return { mark_id: null, company_entity_id: null, skipped: true, reason: "no_company_entity" };
  }
  const confidence = c.confidence ?? SOURCE_CONFIDENCE[c.source_kind] ?? 0.5;
  const dedupe_key = await markDedupeKey(c, entityId);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO valuation_marks (
         id, company_entity_id, company_name_raw, as_of, source_kind, source_url,
         source_ref, implied_valuation_usd, share_price_usd, fully_diluted_shares,
         mark_kind, confidence, holder_name_raw, notes, raw_evidence_json, dedupe_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, entityId, c.company_name_raw, c.as_of, c.source_kind,
      c.source_url ?? null, c.source_ref ?? null,
      c.implied_valuation_usd ?? null, c.share_price_usd ?? null,
      c.fully_diluted_shares ?? null, c.mark_kind ?? null,
      confidence, c.holder_name_raw ?? null, c.notes ?? null,
      c.raw_evidence != null ? JSON.stringify(c.raw_evidence) : null, dedupe_key,
    ).run();
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) {
      return { mark_id: null, company_entity_id: entityId, skipped: true, reason: "duplicate" };
    }
    throw e;
  }
  // Mirror facts.
  const factCtx = {
    entity_id: entityId, source_kind: "scrape" as const, source: SOURCE_TAG,
    evidence_url: c.source_url ?? null, confidence,
  };
  await insertFact(env, {
    ...factCtx, predicate: "valuation.mark", value_text: c.source_kind,
    value_entity_id: id,
    value_json: {
      mark_id: id, source_kind: c.source_kind, as_of: c.as_of,
      implied_valuation_usd: c.implied_valuation_usd ?? null,
      share_price_usd: c.share_price_usd ?? null,
      mark_kind: c.mark_kind ?? null,
    },
  });
  if (c.implied_valuation_usd != null) {
    if (c.source_kind === "primary_round" || c.source_kind === "markdown") {
      await insertFact(env, {
        ...factCtx, predicate: "valuation.latest_post_money_usd",
        value_number: c.implied_valuation_usd,
      });
    } else if (c.source_kind === "secondary_listing") {
      await insertFact(env, {
        ...factCtx, predicate: "valuation.latest_secondary_usd",
        value_number: c.implied_valuation_usd,
      });
    }
  }
  return { mark_id: id, company_entity_id: entityId, skipped: false };
}
