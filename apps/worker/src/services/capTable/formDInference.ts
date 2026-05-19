// Task #5: Form D → cap-table inference.
//
// Form D ("Notice of Sale of Securities") discloses:
//   - issuer name + jurisdiction
//   - total offering amount + total amount sold
//   - date of first sale + exemption (506(b)/506(c))
//   - related persons (officers, directors)
//
// It does NOT disclose:
//   - share count
//   - per-investor allocation
//   - valuation
//
// Inference path: each Form D row in `sec_form_d_rounds` becomes a
// LOW-confidence cap-table snapshot whose "post_money_usd" we
// approximate from the offering total IF a matching deal_event has a
// valuation, OR leave null. No holders are emitted (we don't know
// who bought in).
//
// This is intentionally thin — its value is providing a TIMESTAMPED
// signal that "company raised $X on date Y" which the dilution
// waterfall can interleave between higher-confidence S-1/COI rows.

import type { Env } from "../../types";
import type { CapTableSnapshotInput } from "./types";
import { persistCapTableSnapshot } from "./persist";

interface FormDRow {
  accession_no: string;
  issuer_name: string;
  total_offering_amount: number | null;
  total_amount_sold: number | null;
  date_of_first_sale: string | null;
  entity_id: string | null;
  filing_url: string | null;
}

export async function inferCapTableFromFormD(
  env: Env, accession_no: string,
): Promise<{ snapshot_id: string | null; skipped: boolean; reason?: string }> {
  const row = await env.DB.prepare(
    `SELECT d.accession_no, d.issuer_name, d.total_offering_amount,
            d.total_amount_sold, d.date_of_first_sale, d.entity_id,
            f.filing_url
       FROM sec_form_d_rounds d
       LEFT JOIN sec_filings f ON f.accession_no = d.accession_no
      WHERE d.accession_no = ?`,
  ).bind(accession_no).first<FormDRow>();
  if (!row) return { snapshot_id: null, skipped: true, reason: "form_d_not_found" };
  if (!row.date_of_first_sale) return { snapshot_id: null, skipped: true, reason: "no_date_of_first_sale" };

  // Look for a corroborating deal_event for the same company/month that
  // has a valuation — use it for post_money_usd.
  let postMoney: number | null = null;
  if (row.entity_id) {
    const bucket = row.date_of_first_sale.slice(0, 7);
    const v = await env.DB.prepare(
      `SELECT valuation_usd FROM deal_events
        WHERE company_entity_id = ?
          AND substr(COALESCE(announcement_date, closing_date), 1, 7) = ?
          AND valuation_usd IS NOT NULL
        ORDER BY confidence DESC LIMIT 1`,
    ).bind(row.entity_id, bucket).first<{ valuation_usd: number }>();
    if (v?.valuation_usd) postMoney = v.valuation_usd;
  }

  const input: CapTableSnapshotInput = {
    company_entity_id: row.entity_id,
    company_name_raw: row.issuer_name,
    as_of: row.date_of_first_sale,
    source_kind: "form_d_inference",
    source_url: row.filing_url ?? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=D&accession_number=${accession_no}`,
    source_accession_no: accession_no,
    post_money_usd: postMoney,
    fully_diluted_shares: null,
    option_pool_pct: null,
    notes: `Form D ${accession_no}: offering=${row.total_offering_amount ?? "—"}, sold=${row.total_amount_sold ?? "—"}`,
    holders: [],
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
