// Task #18: Term-sheet persist layer.
//
// Single writer for `preferred_series` and `preferred_series_investors`.
// Per the Task #1 canonical write contract, every derived per-term
// fact (preferred.lp_x, preferred.participating, …) is mirrored onto
// the company entity via `insertFact` — never directly into the
// `facts` table.
//
// Supersedes-chain (matches Task #14 verification_findings pattern):
//   - First write for (company, series_name): is_current=1.
//   - Re-write with materially different terms: insert new is_current=1
//     row, mark prior is_current=0 + superseded_by=<new_id>.
//   - Re-write identical to current: no-op (return existing id).

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { resolveSecEntity } from "../secEdgar/xref";
import type { ParsedSeries } from "./preferredSeriesParser";

/** source_kind values match the canonical `SourceKind` enum
 *  (apps/worker/src/entities/model.ts) so the per-term facts mirrored
 *  via insertFact pass the registry's type gate. SEC filings + press
 *  leaks → "scrape"; operator-uploaded term sheets + Delaware COI
 *  fetches → "import" (matches Task #13 document-import precedent).
 *  There is no dedicated "filing"/"press" value in the enum and adding
 *  one would force a Task #1 / Task #4 registry change. */
export interface UpsertSeriesInput {
  company_entity_id: string;
  series: ParsedSeries;
  source: string;                // 'sec:s1' | 'sec:8k_3.03' | 'document:termSheetParser' | 'delaware_coi' | 'press_leak'
  source_kind: "scrape" | "import";
  source_url: string | null;
  source_accession_no: string | null;
  closing_date?: string | null;  // overrides series.closing_date
  sector?: string | null;        // copied from company facts at write time
}

export interface UpsertSeriesResult {
  id: string;
  created: boolean;             // false when this was a no-op (same-terms replay)
  superseded_prior: string | null;
}

/** Cheap material-equality check — two series rows are "the same"
 *  when every persisted term field matches. Used to decide whether
 *  a re-extraction should append a superseding row or no-op. */
function isMaterialEqual(prior: Record<string, unknown>, next: ParsedSeries): boolean {
  const fields: Array<keyof ParsedSeries> = [
    "liquidation_pref_x", "participating", "participating_cap_x",
    "anti_dilution", "dividend_rate_pct", "dividend_cumulative",
    "conversion_ratio", "protective_provisions_count", "redemption_rights",
    "board_total", "board_investor_seats", "board_founder_seats", "board_independent_seats",
    "original_issue_price_usd",
  ];
  const p = prior as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  for (const f of fields) {
    const a = p[f as string] ?? null;
    const b = n[f as string] ?? null;
    if ((a == null) !== (b == null)) return false;
    if (a != null && b != null && a !== b) return false;
  }
  return true;
}

export async function upsertPreferredSeries(env: Env, input: UpsertSeriesInput): Promise<UpsertSeriesResult> {
  const { series, company_entity_id, source, source_kind, source_url, source_accession_no } = input;
  const closing_date = input.closing_date ?? series.closing_date;

  const prior = await env.DB.prepare(
    `SELECT * FROM preferred_series
       WHERE company_entity_id = ? AND series_name = ? AND is_current = 1
       ORDER BY created_at DESC LIMIT 1`,
  ).bind(company_entity_id, series.series_name).first<Record<string, unknown>>();

  if (prior && isMaterialEqual(prior, series)) {
    return { id: prior.id as string, created: false, superseded_prior: null };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO preferred_series (
       id, company_entity_id, series_name, series_letter,
       original_issue_price_usd, pre_money_usd, raise_amount_usd,
       liquidation_pref_x, participating, participating_cap_x,
       anti_dilution, dividend_rate_pct, dividend_cumulative,
       conversion_ratio, protective_provisions_count, redemption_rights,
       board_total, board_investor_seats, board_founder_seats, board_independent_seats,
       stage, sector, closing_date,
       confidence, source_kind, source, source_url, source_accession_no,
       is_current, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).bind(
    id, company_entity_id, series.series_name, series.series_letter,
    series.original_issue_price_usd, series.pre_money_usd, series.raise_amount_usd,
    series.liquidation_pref_x,
    series.participating == null ? null : series.participating ? 1 : 0,
    series.participating_cap_x,
    series.anti_dilution,
    series.dividend_rate_pct,
    series.dividend_cumulative == null ? null : series.dividend_cumulative ? 1 : 0,
    series.conversion_ratio,
    series.protective_provisions_count,
    series.redemption_rights == null ? null : series.redemption_rights ? 1 : 0,
    series.board_total, series.board_investor_seats, series.board_founder_seats, series.board_independent_seats,
    series.stage, input.sector ?? null, closing_date,
    series.confidence, source_kind, source, source_url, source_accession_no,
    JSON.stringify({
      lead_investor_names: series.lead_investor_names,
      investor_names: series.investor_names,
      warnings: series.warnings,
    }),
  ).run();

  let superseded_prior: string | null = null;
  if (prior) {
    await env.DB.prepare(
      `UPDATE preferred_series SET is_current = 0, superseded_by = ? WHERE id = ?`,
    ).bind(id, prior.id as string).run();
    superseded_prior = prior.id as string;
  }

  // Mirror per-term facts via the canonical insertFact path.
  const factCtx = {
    entity_id: company_entity_id,
    source_kind,
    source,
    evidence_url: source_url,
    confidence: series.confidence,
  };
  const seriesTag = series.series_name; // namespaced predicate-suffix
  if (series.liquidation_pref_x != null) {
    await insertFact(env, { ...factCtx, predicate: `preferred.${seriesTag}.lp_x`, value_number: series.liquidation_pref_x });
  }
  if (series.participating != null) {
    await insertFact(env, { ...factCtx, predicate: `preferred.${seriesTag}.participating`, value_text: series.participating ? "true" : "false" });
  }
  if (series.participating_cap_x != null) {
    await insertFact(env, { ...factCtx, predicate: `preferred.${seriesTag}.participating_cap_x`, value_number: series.participating_cap_x });
  }
  if (series.anti_dilution) {
    await insertFact(env, { ...factCtx, predicate: `preferred.${seriesTag}.anti_dilution`, value_text: series.anti_dilution });
  }
  if (series.dividend_rate_pct != null) {
    await insertFact(env, { ...factCtx, predicate: `preferred.${seriesTag}.dividend_rate_pct`, value_number: series.dividend_rate_pct });
  }
  if (series.original_issue_price_usd != null) {
    await insertFact(env, { ...factCtx, predicate: `preferred.${seriesTag}.original_issue_price_usd`, value_number: series.original_issue_price_usd });
  }
  if (series.board_total != null) {
    await insertFact(env, { ...factCtx, predicate: `preferred.${seriesTag}.board_total`, value_number: series.board_total });
  }

  // Best-effort investor resolution. Rows without a resolved entity
  // are NOT written — raw names live in payload_json for forensics.
  const allNames = Array.from(new Set([...series.lead_investor_names, ...series.investor_names]));
  for (const name of allNames) {
    if (!name || name.length < 3) continue;
    try {
      // Lookup-only: never mint a new investor entity from a raw
      // string scraped out of a charter section. Investor entities
      // must come from the SEC ADV / Form D / dedicated discovery
      // paths so we don't pollute u_entities with hallucinated
      // "ABC Capital" rows from regex matches.
      const xref = await resolveSecEntity(env, { name, kind: "org", source, role: "investor", createIfMissing: false });
      if (!xref?.entity_id) continue;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO preferred_series_investors
           (id, series_id, investor_entity_id, is_lead, raw_name)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), id, xref.entity_id, series.lead_investor_names.includes(name) ? 1 : 0, name).run();
    } catch (e) {
      console.warn("preferred_series_investors resolve failed", name, (e as Error).message);
    }
  }

  return { id, created: true, superseded_prior };
}

/** Look up the latest current series for a company. */
export async function getCurrentPreferredStack(env: Env, companyEntityId: string): Promise<Array<Record<string, unknown>>> {
  const r = await env.DB.prepare(
    `SELECT id, series_name, series_letter, original_issue_price_usd,
            pre_money_usd, raise_amount_usd,
            liquidation_pref_x, participating, participating_cap_x,
            anti_dilution, dividend_rate_pct, dividend_cumulative,
            conversion_ratio, protective_provisions_count, redemption_rights,
            board_total, board_investor_seats, board_founder_seats, board_independent_seats,
            stage, sector, closing_date, confidence,
            source_kind, source, source_url, source_accession_no, created_at,
            payload_json
       FROM preferred_series
      WHERE company_entity_id = ? AND is_current = 1
      ORDER BY closing_date DESC NULLS LAST, created_at DESC`,
  ).bind(companyEntityId).all<Record<string, unknown>>();
  return r.results ?? [];
}
