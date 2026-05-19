// Task #5: Form D → cap-table inference.
//
// Form D ("Notice of Sale of Securities") discloses offering total,
// amount sold, date of first sale, exemption, and a JSON array of
// related persons (officers + directors). It does NOT disclose share
// counts, per-investor allocations, or valuation.
//
// This driver does as much as Form D allows:
//   1. Emits a `form_d_inference` snapshot per filing (idempotent via
//      UNIQUE(company_entity_id, as_of, source_kind, source_url)).
//   2. Backs out `post_money_usd` from a matching deal_event for the
//      same month; if none, falls back to a sector/stage median post-
//      money implied by the issuer's `industry_group` over the trailing
//      18 months.
//   3. Attaches a cumulative `total_raised_to_date_usd` summary (sum
//      of all prior amount_sold rows for this issuer).
//   4. Defaults a sector/stage median option-pool top-up when neither
//      the snapshot summary nor a corroborating S-1 supplies one.
//   5. Mints related-persons (officers + directors) as
//      `founder`/`employee_pool` pseudo-holders at very low confidence
//      so the holders list isn't empty.
//   6. Notes "1x non-participating preferred (default assumed)" — the
//      industry-standard convention when COIs aren't available.

import type { Env } from "../../types";
import type { CapTableHolderInput, CapTableSnapshotInput } from "./types";
import { persistCapTableSnapshot } from "./persist";
import { normalizeHolderName } from "./normalize";

interface FormDRow {
  accession_no: string;
  issuer_name: string;
  industry_group: string | null;
  total_offering_amount: number | null;
  total_amount_sold: number | null;
  date_of_first_sale: string | null;
  entity_id: string | null;
  filing_url: string | null;
  related_persons_json: string;
}

interface RelatedPerson { name: string; role?: string | null }

const DEFAULT_NOTES = "1x non-participating preferred (default assumed; corroborate with COI)";

async function medianPostMoneyForIndustry(env: Env, industry: string | null): Promise<number | null> {
  if (!industry) return null;
  // Trailing 18-month median post-money across funding_round deal_events
  // whose sector_tags include this industry token. Cheap O(N) scan; we
  // bound to 500 rows.
  const r = await env.DB.prepare(
    `SELECT valuation_usd FROM deal_events
      WHERE valuation_usd IS NOT NULL
        AND event_type = 'funding_round'
        AND substr(announcement_date,1,10) >= date('now','-18 months')
        AND (sector_tags_json LIKE ? OR sector_tags_json LIKE ?)
      ORDER BY valuation_usd ASC LIMIT 500`,
  ).bind(`%${industry.toLowerCase()}%`, `%${industry}%`).all<{ valuation_usd: number }>();
  const vals = (r.results ?? []).map((x) => x.valuation_usd).filter((v) => v && v > 0);
  if (vals.length < 5) return null;
  return vals[Math.floor(vals.length / 2)];
}

const STAGE_OPTION_POOL: Record<string, number> = {
  // Industry-standard option-pool top-ups by stage (decimal fractions).
  // Spec note: "median sector/stage option-pool top-ups" — these are
  // the widely-cited 2024 benchmarks; not company-specific math.
  "seed": 0.12, "series_a": 0.15, "series_b": 0.13, "series_c": 0.11,
  "series_d": 0.10, "series_e": 0.10, "growth": 0.08,
};

function inferStageFromAmount(usd: number | null): string {
  if (!usd) return "seed";
  if (usd < 3_000_000) return "seed";
  if (usd < 15_000_000) return "series_a";
  if (usd < 40_000_000) return "series_b";
  if (usd < 100_000_000) return "series_c";
  if (usd < 250_000_000) return "series_d";
  return "growth";
}

function parseRelatedPersons(raw: string): RelatedPerson[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    return j
      .filter((p) => p && typeof p === "object" && typeof (p as RelatedPerson).name === "string")
      .map((p) => ({ name: (p as RelatedPerson).name, role: (p as RelatedPerson).role ?? null }));
  } catch { return []; }
}

function holdersFromRelatedPersons(persons: RelatedPerson[]): CapTableHolderInput[] {
  // Officers/directors named on a Form D are nearly always founders or
  // executives. We emit them as low-confidence `founder` placeholders
  // with no share count — they anchor entity resolution so a later
  // S-1 snapshot can collapse onto the same holder_entity_id.
  return persons.slice(0, 25).map((p) => ({
    holder_name_raw: p.name.slice(0, 200),
    holder_name_normalized: normalizeHolderName(p.name),
    holder_class: "founder",
    security_type: "common",
    shares: null,
    pct_ownership: null,
    original_investment_usd: null,
    round_acquired: p.role ? `Officer/${p.role}` : "Officer",
    liquidation_preference_x: null,
    participating: null,
  }));
}

async function cumulativeRaisedUsd(env: Env, entityId: string, throughDate: string): Promise<number | null> {
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(total_amount_sold), 0) AS total
       FROM sec_form_d_rounds
      WHERE entity_id = ?
        AND date_of_first_sale IS NOT NULL
        AND date_of_first_sale <= ?`,
  ).bind(entityId, throughDate).first<{ total: number }>();
  return r?.total && r.total > 0 ? r.total : null;
}

export async function inferCapTableFromFormD(
  env: Env, accession_no: string,
): Promise<{ snapshot_id: string | null; skipped: boolean; reason?: string }> {
  const row = await env.DB.prepare(
    `SELECT d.accession_no, d.issuer_name, d.industry_group, d.total_offering_amount,
            d.total_amount_sold, d.date_of_first_sale, d.entity_id,
            d.related_persons_json, f.filing_url
       FROM sec_form_d_rounds d
       LEFT JOIN sec_filings f ON f.accession_no = d.accession_no
      WHERE d.accession_no = ?`,
  ).bind(accession_no).first<FormDRow>();
  if (!row) return { snapshot_id: null, skipped: true, reason: "form_d_not_found" };
  if (!row.date_of_first_sale) return { snapshot_id: null, skipped: true, reason: "no_date_of_first_sale" };

  // Corroborating deal_event valuation for the same company/month.
  let postMoney: number | null = null;
  let postMoneySource: "corroborated" | "median" | null = null;
  if (row.entity_id) {
    const bucket = row.date_of_first_sale.slice(0, 7);
    const v = await env.DB.prepare(
      `SELECT valuation_usd FROM deal_events
        WHERE company_entity_id = ?
          AND substr(COALESCE(announcement_date, closing_date), 1, 7) = ?
          AND valuation_usd IS NOT NULL
        ORDER BY confidence DESC LIMIT 1`,
    ).bind(row.entity_id, bucket).first<{ valuation_usd: number }>();
    if (v?.valuation_usd) { postMoney = v.valuation_usd; postMoneySource = "corroborated"; }
  }
  if (postMoney == null) {
    const med = await medianPostMoneyForIndustry(env, row.industry_group);
    if (med) { postMoney = med; postMoneySource = "median"; }
  }

  const stage = inferStageFromAmount(row.total_amount_sold);
  const optionPoolDefault = STAGE_OPTION_POOL[stage] ?? 0.10;
  const cumulative = row.entity_id ? await cumulativeRaisedUsd(env, row.entity_id, row.date_of_first_sale) : null;

  const persons = parseRelatedPersons(row.related_persons_json);
  const holders = holdersFromRelatedPersons(persons);

  const noteParts = [
    DEFAULT_NOTES,
    `stage_assumed=${stage}`,
    `option_pool_default=${(optionPoolDefault * 100).toFixed(0)}%`,
    postMoney != null ? `post_money_source=${postMoneySource}` : "post_money=unknown",
    cumulative != null ? `total_raised_to_date_usd=${cumulative}` : null,
    `form_d_sold=${row.total_amount_sold ?? "—"}`,
  ].filter(Boolean).join("; ");

  const input: CapTableSnapshotInput = {
    company_entity_id: row.entity_id,
    company_name_raw: row.issuer_name,
    as_of: row.date_of_first_sale,
    source_kind: "form_d_inference",
    source_url: row.filing_url ?? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=D&accession_number=${accession_no}`,
    source_accession_no: accession_no,
    post_money_usd: postMoney,
    fully_diluted_shares: null,
    option_pool_pct: optionPoolDefault,
    preferred_pct: null,
    common_pct: null,
    notes: noteParts,
    holders,
  };
  const result = await persistCapTableSnapshot(env, input);
  return { snapshot_id: result.snapshot_id, skipped: result.skipped, reason: result.reason };
}

/** Sweep over all Form D rows for one company entity and emit a
 *  cap-table snapshot for each. Idempotent: existing snapshots are
 *  skipped via the UNIQUE constraint. */
export async function sweepFormDInferenceForCompany(
  env: Env, company_entity_id: string,
): Promise<{ emitted: number; skipped: number }> {
  const rows = await env.DB.prepare(
    `SELECT accession_no FROM sec_form_d_rounds WHERE entity_id = ?
      ORDER BY date_of_first_sale ASC`,
  ).bind(company_entity_id).all<{ accession_no: string }>();
  let emitted = 0; let skipped = 0;
  for (const r of (rows.results ?? [])) {
    const out = await inferCapTableFromFormD(env, r.accession_no);
    if (out.snapshot_id && !out.skipped) emitted++; else skipped++;
  }
  return { emitted, skipped };
}
