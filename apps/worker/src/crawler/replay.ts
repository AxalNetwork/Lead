// Task #2 step 4 (replay): re-run an adapter against the most recent
// R2 snapshot for a URL. This is the explicit replay path that turns
// the 7-day HTML archive into a debugging surface — given the same URL,
// `replayFromArchive` reproduces the extraction without re-fetching.

import type { Env } from "../types";
import { readArchive } from "./archive";
import { runAdapter, type RunAdapterOutcome } from "./adapters";

export interface ReplayResult {
  ok: boolean;
  url: string;
  archive_key: string | null;
  fetched_at: string | null;
  adapter: RunAdapterOutcome | null;
  /** Set when no archive entry exists within the 7-day TTL window. */
  reason: "no_archive" | null;
}

/** Pull `url`'s most recent archived HTML out of R2 (within the 7-day
 *  TTL) and re-run the matching site adapter against it. Returns a
 *  structured result so the caller can compare a fresh extraction
 *  against the snapshotted one (regression debugging, adapter rev). */
export async function replayFromArchive(env: Env, url: string): Promise<ReplayResult> {
  const snap = await readArchive(env, url);
  if (!snap) {
    return { ok: false, url, archive_key: null, fetched_at: null, adapter: null, reason: "no_archive" };
  }
  const outcome = runAdapter(url, snap.html);
  return {
    ok: true,
    url,
    archive_key: snap.key,
    fetched_at: snap.fetched_at || null,
    adapter: outcome,
    reason: null,
  };
}
