// Task #3: VC Source Registry — selector helper.
//
// Downstream adapters consult this helper to discover *which* source to
// fetch for a given (data_type, jurisdiction) pair, rather than hard-coding
// URLs across extractors. Returns the highest-priority enabled rows
// matching the filter.
//
// Contract:
//   selectSourcesFor({ data_type, jurisdiction? }) returns rows sorted
//   by priority DESC, then by last_success_at DESC (freshest first as a
//   tiebreaker). Disabled rows are excluded. When jurisdiction is omitted,
//   global-coverage rows + every region match are returned.
//
// data_fields_json is parsed eagerly to a string[] so callers can pick
// the highest-priority source that yields a specific requested field.

import type { Env } from "../types";

export interface VcSourceRow {
  id: string;
  jurisdiction: string;
  authority: string;
  data_type: string;
  source_name: string;
  base_url: string;
  access_pattern: string;
  refresh_cadence: string;
  authentication: string;
  auth_notes: string | null;
  historical_depth: string | null;
  data_fields: string[];
  seed_url_template: string | null;
  enabled: number;
  priority: number;
  last_crawled_at: string | null;
  last_success_at: string | null;
  notes: string | null;
}

interface VcSourceRawRow extends Omit<VcSourceRow, "data_fields"> {
  data_fields_json: string;
}

export interface SelectSourcesQuery {
  data_type: string;
  jurisdiction?: string;
  authority?: string;
  // When provided, only sources whose data_fields array contains the field
  // are returned. Useful for "give me any source that yields aum_usd".
  yields_field?: string;
  limit?: number;
}

function parseFields(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

function hydrate(r: VcSourceRawRow): VcSourceRow {
  const { data_fields_json, ...rest } = r;
  return { ...rest, data_fields: parseFields(data_fields_json) };
}

export async function selectSourcesFor(env: Env, q: SelectSourcesQuery): Promise<VcSourceRow[]> {
  if (!q.data_type) return [];
  const wheres: string[] = ["enabled = 1", "data_type = ?"];
  const binds: Array<string | number> = [q.data_type];
  if (q.jurisdiction) { wheres.push("jurisdiction = ?"); binds.push(q.jurisdiction); }
  if (q.authority)    { wheres.push("authority = ?");    binds.push(q.authority); }

  const limit = Math.max(1, Math.min(500, q.limit ?? 50));
  // When yields_field is set we must post-filter against a JSON column, so
  // applying SQL LIMIT first would silently drop matches beyond the cutoff
  // (and in selectBestSourceFor would return null even when valid lower-
  // priority sources exist). Fetch a broad candidate pool, then post-filter,
  // then trim to the requested limit. Without yields_field, SQL LIMIT is
  // exact and we pass the requested limit straight through.
  const sqlLimit = q.yields_field ? 500 : limit;
  const sql = `SELECT id, jurisdiction, authority, data_type, source_name, base_url,
                      access_pattern, refresh_cadence, authentication, auth_notes,
                      historical_depth, data_fields_json, seed_url_template, enabled,
                      priority, last_crawled_at, last_success_at, notes
                 FROM vc_sources
                WHERE ${wheres.join(" AND ")}
                ORDER BY priority DESC,
                         CASE WHEN last_success_at IS NULL THEN 1 ELSE 0 END,
                         last_success_at DESC
                LIMIT ?`;
  const r = await env.DB.prepare(sql).bind(...binds, sqlLimit).all<VcSourceRawRow>();
  const rows = (r.results ?? []).map(hydrate);
  if (q.yields_field) {
    const f = q.yields_field;
    return rows.filter((row) => row.data_fields.includes(f)).slice(0, limit);
  }
  return rows;
}

// Convenience: return the single best (highest-priority enabled) source.
// Handy from extractor code paths that want exactly one URL to hit.
export async function selectBestSourceFor(env: Env, q: SelectSourcesQuery): Promise<VcSourceRow | null> {
  const rows = await selectSourcesFor(env, { ...q, limit: 1 });
  return rows[0] ?? null;
}
