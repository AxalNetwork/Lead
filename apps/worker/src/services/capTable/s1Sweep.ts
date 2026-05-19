// Task #5: S-1 sweep — finds all S-1 filings for a given entity in
// the local `sec_filings` ledger and runs cap-table inference on each
// (so a rebuild from the admin route re-inflates snapshots from any
// previously archived S-1s without re-crawling EDGAR).

import type { Env } from "../../types";
import { inferCapTableFromS1 } from "./s1Inference";

export async function sweepS1InferenceForCompany(
  env: Env, entityId: string,
): Promise<{ filings_seen: number; snapshots_written: number; holders_written: number; skipped: number }> {
  const r = await env.DB.prepare(
    `SELECT accession_no FROM sec_filings
      WHERE entity_id = ? AND form_type = 'S-1'
      ORDER BY filed_at DESC LIMIT 25`,
  ).bind(entityId).all<{ accession_no: string }>();
  const rows = r.results ?? [];
  let snapshots = 0, holders = 0, skipped = 0;
  for (const row of rows) {
    try {
      const out = await inferCapTableFromS1(env, row.accession_no);
      if (out.snapshot_id) {
        snapshots++;
        holders += out.holders_written;
      } else {
        skipped++;
      }
    } catch (e) {
      console.warn("sweepS1InferenceForCompany failed", row.accession_no, (e as Error).message);
      skipped++;
    }
  }
  return { filings_seen: rows.length, snapshots_written: snapshots, holders_written: holders, skipped };
}
