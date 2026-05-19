// Task #5: Delaware Certificate-of-Incorporation → cap-table driver.
//
// Fetches the COI HTML/PDF via the in-house crawler, runs the
// authorized-class extractor, and persists a `delaware_coi` snapshot.
// COIs typically disclose authorized-share *classes* (not named
// holders), so the snapshot carries class authorizations as
// pseudo-holders (e.g. "Series A authorized pool") plus the total
// authorized count in `fully_diluted_shares`.

import type { Env } from "../../types";
import { fetchPage } from "../../scraper/fetcher";
import { extractDelawareCoi } from "./deCoiParser";
import { persistCapTableSnapshot } from "./persist";
import type { CapTablePersistResult, CapTableSnapshotInput } from "./types";

export interface DeCoiInferenceInput {
  company_entity_id: string | null;
  company_name_raw: string;
  source_url: string;
  filed_at?: string | null;
}

function skip(reason: string, company_entity_id: string | null): CapTablePersistResult {
  return { snapshot_id: null, company_entity_id, holders_written: 0, skipped: true, reason };
}

export async function inferCapTableFromDeCoi(
  env: Env, input: DeCoiInferenceInput,
): Promise<CapTablePersistResult> {
  const r = await fetchPage(env, input.source_url, { minIntervalMs: 4000 });
  if (!r.ok || !r.html || r.html.length < 500) return skip("fetch_failed", input.company_entity_id);
  const ex = extractDelawareCoi(r.html);
  if (!ex.ok) return skip(ex.reason ?? "extract_failed", input.company_entity_id);
  if (!ex.holders.length) return skip("no_holders", input.company_entity_id);
  const asOf = input.filed_at ?? new Date().toISOString().slice(0, 10);
  const snap: CapTableSnapshotInput = {
    company_entity_id: input.company_entity_id,
    company_name_raw: input.company_name_raw,
    as_of: asOf,
    source_kind: "delaware_coi",
    source_url: input.source_url,
    source_accession_no: null,
    fully_diluted_shares: ex.total_authorized,
    post_money_usd: null,
    option_pool_pct: null,
    preferred_pct: null,
    common_pct: null,
    notes: ex.par_value_usd != null ? `par_value_usd=${ex.par_value_usd}` : null,
    holders: ex.holders,
  };
  return persistCapTableSnapshot(env, snap);
}
