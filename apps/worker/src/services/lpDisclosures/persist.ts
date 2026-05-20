// Task #2: LP-disclosure persist layer.
//
// Consumes an `LpDisclosurePayload` from an LP adapter and writes:
//   1. The LP entity (created on first encounter via canonical
//      createEntity), plus `lp.class` + `lp.slug` identifier facts.
//   2. For each commitment row:
//      - resolveFundName → fund entity (+ gp_firm entity when hinted)
//      - INSERT OR REPLACE INTO lp_fund_commitments  (idempotent on
//        (lp_entity_id, fund_name_raw, as_of_date))
//      - corroborating facts (`fund.lp_commitment_usd`,
//        `firm.lp_committed_usd`) via insertFact so the entity-fact
//        graph reflects the LP-GP relationship.
//
// All entity / fact writes route through canonical helpers per the
// replit.md Task #1 decision — adapters / persist NEVER INSERT into
// u_entities or facts directly.

import type { Env } from "../../types";
import type { LpDisclosurePayload } from "../../crawler/adapters/lpDisclosures/types";
import { insertFact } from "../../entities/facts";
import { createEntity, addRole } from "../../entities/roles";
import { resolveFundName } from "../fundResolver";

export interface LpPersistResult {
  lp_entity_id: string;
  rows_written: number;
  rows_skipped: number;
  rows_missing_as_of: number;
  facts_written: number;
  as_of_used: string | null;
}

/**
 * Deterministic as_of_date selection. CRITICAL for idempotency: the
 * UNIQUE key (lp_entity_id, fund_name_raw, as_of_date) makes
 * re-ingest a no-op ONLY when as_of_date is stable across re-fetches.
 * Returns null when the disclosure carries no usable period stamp —
 * the caller must then skip the row (we never fall back to "today",
 * which would mint a new row on every refresh).
 *
 * Exported for test coverage.
 */
export function chooseAsOfDate(payload: LpDisclosurePayload): string | null {
  return payload.as_of_date ?? payload.filing_date ?? null;
}

async function findLpEntityBySlug(env: Env, slug: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT entity_id FROM facts
      WHERE predicate = 'lp.slug' AND value_text = ? AND is_current = 1
      LIMIT 1`,
  ).bind(slug).first<{ entity_id: string }>();
  return r?.entity_id ?? null;
}

async function ensureLpEntity(env: Env, payload: LpDisclosurePayload, source: string): Promise<string> {
  const existing = await findLpEntityBySlug(env, payload.lp_slug);
  if (existing) return existing;
  const row = await createEntity(env, {
    kind: "org",
    display_name: payload.lp_display_name,
    suppressAutoProfileFill: true,
  });
  if (!row) return null; // Task #9: rejected by garbage detector
  await addRole(env, row.id, "lp", { is_primary: true, source, confidence: 0.95 });
  const ctx = {
    entity_id: row.id, source_kind: "scrape" as const, source,
    evidence_url: payload.source_url, confidence: 0.95,
  };
  await insertFact(env, { ...ctx, predicate: "lp.slug", value_text: payload.lp_slug });
  await insertFact(env, { ...ctx, predicate: "lp.class", value_text: payload.lp_class });
  await insertFact(env, { ...ctx, predicate: "lp.display_name", value_text: payload.lp_display_name });
  return row.id;
}

/**
 * Top-level persister. Idempotent on (lp_entity_id, fund_name_raw,
 * as_of_date) — re-ingesting the same disclosure overwrites the same
 * rows. Returns a summary so the caller (engine / cron) can log per-run
 * counts.
 */
export async function persistLpDisclosure(
  env: Env,
  payload: LpDisclosurePayload,
  source: string = `lp_disclosure:${payload.lp_slug}`,
): Promise<LpPersistResult> {
  const lp_entity_id = await ensureLpEntity(env, payload, source);
  const as_of = chooseAsOfDate(payload);
  let rows_written = 0;
  let rows_skipped = 0;
  let rows_missing_as_of = 0;
  let facts_written = 0;

  // Refuse to write rows without a deterministic period stamp — that
  // would defeat the UNIQUE idempotency contract on every refresh.
  if (!as_of) {
    if (payload.commitments.length > 0) {
      console.warn(
        "lpDisclosure persist: skipped",
        payload.commitments.length,
        "rows — no as_of_date or filing_date on",
        payload.source_url,
      );
    }
    return {
      lp_entity_id,
      rows_written: 0,
      rows_skipped: 0,
      rows_missing_as_of: payload.commitments.length,
      facts_written: 0,
      as_of_used: null,
    };
  }

  for (const c of payload.commitments) {
    if (!c.fund_name_raw || c.fund_name_raw.length < 3) { rows_skipped++; continue; }
    const resolved = await resolveFundName(env, {
      raw: c.fund_name_raw,
      lp_entity_id,
      vintage_hint: c.vintage_year ?? null,
      gp_firm_hint: c.gp_firm_hint ?? null,
      source,
      evidence_url: payload.source_url,
    });
    // Row-level confidence: floor at adapter signal, lifted by resolver
    // certainty. ≥2-source corroboration is detected at query time
    // (multiple rows for the same fund_entity_id across LPs) — here we
    // only know single-source certainty.
    const confidence = Math.min(0.99, 0.4 + 0.5 * resolved.confidence);
    await env.DB.prepare(
      `INSERT INTO lp_fund_commitments (
         id, lp_entity_id, fund_entity_id, fund_name_raw, gp_firm_entity_id,
         vintage_year, committed_usd, called_usd, distributed_usd, nav_usd,
         net_irr_pct, tvpi, dpi, as_of_date,
         source_id, source_url, source_filing_date, confidence,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(lp_entity_id, fund_name_raw, as_of_date) DO UPDATE SET
         fund_entity_id    = excluded.fund_entity_id,
         gp_firm_entity_id = excluded.gp_firm_entity_id,
         vintage_year      = COALESCE(excluded.vintage_year, lp_fund_commitments.vintage_year),
         committed_usd     = COALESCE(excluded.committed_usd, lp_fund_commitments.committed_usd),
         called_usd        = COALESCE(excluded.called_usd, lp_fund_commitments.called_usd),
         distributed_usd   = COALESCE(excluded.distributed_usd, lp_fund_commitments.distributed_usd),
         nav_usd           = COALESCE(excluded.nav_usd, lp_fund_commitments.nav_usd),
         net_irr_pct       = COALESCE(excluded.net_irr_pct, lp_fund_commitments.net_irr_pct),
         tvpi              = COALESCE(excluded.tvpi, lp_fund_commitments.tvpi),
         dpi               = COALESCE(excluded.dpi, lp_fund_commitments.dpi),
         source_id         = excluded.source_id,
         source_url        = excluded.source_url,
         source_filing_date= excluded.source_filing_date,
         confidence        = MAX(excluded.confidence, lp_fund_commitments.confidence),
         updated_at        = CURRENT_TIMESTAMP`,
    ).bind(
      crypto.randomUUID(), lp_entity_id, resolved.fund_entity_id, c.fund_name_raw, resolved.gp_firm_entity_id,
      c.vintage_year, c.committed_usd, c.called_usd, c.distributed_usd, c.nav_usd,
      c.net_irr_pct, c.tvpi, c.dpi, as_of,
      source, payload.source_url, payload.filing_date, confidence,
    ).run();
    rows_written++;

    // Corroborating facts via canonical write path. We tag the fund
    // entity with the LP commitment (predicate `fund.lp_commitment_usd`,
    // value_entity_id = LP) and, when a GP firm is resolved, increment
    // its known-LP-base on the firm entity.
    if (resolved.fund_entity_id && c.committed_usd != null) {
      await insertFact(env, {
        entity_id: resolved.fund_entity_id,
        predicate: "fund.lp_commitment_usd",
        value_number: c.committed_usd,
        value_entity_id: lp_entity_id,
        value_json: { lp_slug: payload.lp_slug, as_of_date: as_of, vintage_year: c.vintage_year },
        source_kind: "scrape", source,
        evidence_url: payload.source_url,
        confidence,
        observed_at: `${as_of}T00:00:00Z`,
      });
      facts_written++;
    }
    if (resolved.gp_firm_entity_id && c.committed_usd != null) {
      await insertFact(env, {
        entity_id: resolved.gp_firm_entity_id,
        predicate: "firm.lp_committed_usd",
        value_number: c.committed_usd,
        value_entity_id: lp_entity_id,
        value_json: { lp_slug: payload.lp_slug, fund_name_raw: c.fund_name_raw, as_of_date: as_of },
        source_kind: "scrape", source,
        evidence_url: payload.source_url,
        confidence,
        observed_at: `${as_of}T00:00:00Z`,
      });
      facts_written++;
    }
  }

  return {
    lp_entity_id, rows_written, rows_skipped,
    rows_missing_as_of, facts_written, as_of_used: as_of,
  };
}
