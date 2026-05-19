// Task #5: Delaware Division of Corporations — metadata-only path.
//
// The Delaware SOS public search exposes free entity metadata
// (file number, formation date, entity status, registered agent)
// WITHOUT the underlying COI text. When the full COI isn't
// available (it's pay-walled at the per-document level), we still
// emit a very-low-confidence `delaware_coi` snapshot carrying only
// the metadata so the dilution waterfall has at least an
// incorporation anchor for the company.
//
// No holders are emitted. The snapshot is tagged
// `metadata_only=true` in `notes` so the UI can render it
// differently from a real COI extract.

import type { Env } from "../../types";
import { persistCapTableSnapshot } from "./persist";
import type { CapTablePersistResult, CapTableSnapshotInput } from "./types";

export interface DeSosMetadataInput {
  company_entity_id: string | null;
  company_name_raw: string;
  file_number: string;            // DE entity file number (e.g. "4567890")
  formation_date: string;         // ISO date
  entity_status?: string | null;
  registered_agent?: string | null;
  source_url?: string | null;     // SOS search-result URL
}

export async function inferCapTableFromDelawareSosMetadata(
  env: Env, input: DeSosMetadataInput,
): Promise<CapTablePersistResult> {
  const noteParts = [
    "metadata_only=true",
    `de_file_number=${input.file_number}`,
    input.entity_status ? `entity_status=${input.entity_status}` : null,
    input.registered_agent ? `registered_agent=${input.registered_agent.slice(0, 80)}` : null,
  ].filter(Boolean).join("; ");
  const snap: CapTableSnapshotInput = {
    company_entity_id: input.company_entity_id,
    company_name_raw: input.company_name_raw,
    as_of: input.formation_date,
    source_kind: "delaware_coi",
    source_url: input.source_url
      ?? `https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx?file=${encodeURIComponent(input.file_number)}`,
    source_accession_no: null,
    fully_diluted_shares: null,
    post_money_usd: null,
    option_pool_pct: null,
    preferred_pct: null,
    common_pct: null,
    // Spec note: metadata-only emissions are deliberately low-confidence
    // so the "best snapshot" picker prefers any real extraction.
    confidence: 0.25,
    notes: noteParts,
    holders: [],
  };
  return persistCapTableSnapshot(env, snap);
}
