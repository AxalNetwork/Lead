// Task #5: S-1 → cap-table inference driver.
//
// Lives between the SEC EDGAR adapter (apps/worker/src/crawler/adapters/
// secEdgar.ts) and the cap-table persist layer. We:
//   1. Look up the sec_filings row for the S-1 accession.
//   2. Fetch the primary filing HTML through the in-house `fetchPage`
//      (which honors robots, per-host throttling, the circuit breaker,
//      and archives a copy to R2 by itself — per Task #1's "all
//      ingestion through the in-house crawler engine" contract).
//   3. Run `extractS1CapTable` on the body.
//   4. Emit a snapshot with `as_of = filed_at`.
//
// We intentionally do NOT re-extract from a stored R2 archive here:
// the SEC adapter's R2 keying convention is owned by the crawler
// engine, not by service-layer callers. Going through fetchPage means
// the engine handles archival via its own path, and a cache hit at the
// network tier still avoids any re-fetch cost.

import type { Env } from "../../types";
import { extractS1CapTable } from "./s1CapTableParser";
import { persistCapTableSnapshot } from "./persist";
import type { CapTableSnapshotInput } from "./types";
import { fetchPage } from "../../scraper/fetcher";

interface S1Row {
  accession_no: string;
  filer_name: string | null;
  filed_at: string | null;
  filing_url: string;
  primary_doc_url: string | null;
  entity_id: string | null;
}

async function loadFilingHtml(env: Env, row: S1Row): Promise<string | null> {
  const candidates = [row.primary_doc_url, row.filing_url].filter(Boolean) as string[];
  for (const url of candidates) {
    try {
      const r = await fetchPage(env, url, { minIntervalMs: 4000 });
      if (r.ok && r.html && r.html.length > 1000) return r.html;
    } catch (e) {
      console.warn("loadFilingHtml fetchPage failed", url, (e as Error).message);
    }
  }
  return null;
}

export async function inferCapTableFromS1(
  env: Env, accession_no: string,
): Promise<{ snapshot_id: string | null; skipped: boolean; reason?: string; holders_written: number }> {
  const row = await env.DB.prepare(
    `SELECT accession_no, filer_name, filed_at, filing_url, primary_doc_url, entity_id
       FROM sec_filings WHERE accession_no = ? AND form_type = 'S-1'`,
  ).bind(accession_no).first<S1Row>();
  if (!row) return { snapshot_id: null, skipped: true, reason: "s1_not_found", holders_written: 0 };
  const html = await loadFilingHtml(env, row);
  if (!html) return { snapshot_id: null, skipped: true, reason: "fetch_failed", holders_written: 0 };
  return inferCapTableFromS1Html(env, row, html);
}

/** Pure-input variant: caller already has the HTML. Used by adapters
 *  that have a body in hand and don't want to re-fetch. */
export async function inferCapTableFromS1Html(
  env: Env, row: S1Row, html: string,
): Promise<{ snapshot_id: string | null; skipped: boolean; reason?: string; holders_written: number }> {
  const ex = extractS1CapTable(html);
  if (!ex.ok || !ex.snapshot) {
    return { snapshot_id: null, skipped: true, reason: ex.reason ?? "extract_failed", holders_written: 0 };
  }
  const asOf = row.filed_at ?? new Date().toISOString().slice(0, 10);
  const input: CapTableSnapshotInput = {
    company_entity_id: row.entity_id,
    company_name_raw: row.filer_name ?? "Unknown S-1 filer",
    as_of: asOf,
    source_kind: "s1_filing",
    source_url: row.filing_url,
    source_accession_no: row.accession_no,
    fully_diluted_shares: ex.snapshot.fully_diluted_shares ?? null,
    post_money_usd: null,
    option_pool_pct: ex.snapshot.option_pool_pct ?? null,
    preferred_pct: ex.snapshot.preferred_pct ?? null,
    common_pct: ex.snapshot.common_pct ?? null,
    notes: ex.snapshot.notes ?? null,
    holders: ex.holders,
  };
  const result = await persistCapTableSnapshot(env, input);
  return {
    snapshot_id: result.snapshot_id,
    skipped: result.skipped,
    reason: result.reason,
    holders_written: result.holders_written,
  };
}
