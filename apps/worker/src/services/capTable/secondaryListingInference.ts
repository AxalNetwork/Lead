// Task #5: Secondary-listing → cap-table driver.
//
// Fetches a secondary-market listing page (Forge, EquityZen, Hiive,
// etc.) via the in-house crawler and persists a low-confidence
// snapshot built from `extractSecondaryListing`'s partial payload.
// These listings rarely name holders, but they pin valuation /
// share-count anchors that the dilution waterfall needs.

import type { Env } from "../../types";
import { fetchPage } from "../../scraper/fetcher";
import { extractSecondaryListing } from "./secondaryListingParser";
import { persistCapTableSnapshot } from "./persist";
import type { CapTablePersistResult, CapTableSnapshotInput } from "./types";

export interface SecondaryListingInferenceInput {
  company_entity_id: string | null;
  company_name_raw: string;
  listing_url: string;
  as_of?: string | null;
}

function skip(reason: string, company_entity_id: string | null): CapTablePersistResult {
  return { snapshot_id: null, company_entity_id, holders_written: 0, skipped: true, reason };
}

export async function inferCapTableFromSecondaryListing(
  env: Env, input: SecondaryListingInferenceInput,
): Promise<CapTablePersistResult> {
  const r = await fetchPage(env, input.listing_url, { minIntervalMs: 4000 });
  if (!r.ok || !r.html || r.html.length < 500) return skip("fetch_failed", input.company_entity_id);
  const ex = extractSecondaryListing(r.html, input.listing_url);
  if (!ex.ok) return skip(ex.reason ?? "extract_failed", input.company_entity_id);
  const asOf = input.as_of ?? ex.partial.as_of ?? new Date().toISOString().slice(0, 10);
  const snap: CapTableSnapshotInput = {
    company_entity_id: input.company_entity_id,
    company_name_raw: ex.partial.company_name_raw ?? input.company_name_raw,
    as_of: asOf,
    source_kind: "secondary_listing",
    source_url: input.listing_url,
    source_accession_no: null,
    fully_diluted_shares: ex.partial.fully_diluted_shares ?? null,
    post_money_usd: ex.partial.post_money_usd ?? null,
    option_pool_pct: null,
    preferred_pct: null,
    common_pct: null,
    notes: ex.partial.notes ?? null,
    holders: ex.partial.holders ?? [],
  };
  return persistCapTableSnapshot(env, snap);
}
