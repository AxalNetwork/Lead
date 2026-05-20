// Task #6 Section C: per-slice health probe for GET /api/profile/:id.
//
// Probe definitions MIRROR the exact tables/columns that
// `buildProfileEnvelope` in `routes/profile.ts` (and the
// `getProfileAxes` helper in `profile/repo.ts`) read at request time.
// If the envelope's slice loaders change, update this list to match —
// the goal is operators see "table reachable, schema matches" per
// real slice, not a parallel guess at the schema.

import type { Env } from "../types";

interface SliceResult {
  slice: string;
  ok: boolean;
  ms: number;
  error?: string;
}

interface Probe {
  slice: string;
  sql: string;
  binds: (id: string) => unknown[];
}

const PROBES: Probe[] = [
  // Header row + the basic entity lookup the envelope does first.
  { slice: "entity",              sql: `SELECT id FROM u_entities WHERE id = ? LIMIT 1`,                                                          binds: (id) => [id] },
  // Slice loaders, in the order Promise.allSettled fires them in buildProfileEnvelope.
  { slice: "facts",               sql: `SELECT id FROM facts WHERE entity_id = ? AND is_current = 1 LIMIT 1`,                                     binds: (id) => [id] },
  { slice: "roles",               sql: `SELECT role FROM entity_roles WHERE entity_id = ? LIMIT 1`,                                               binds: (id) => [id] },
  { slice: "channels",            sql: `SELECT kind FROM channels WHERE entity_id = ? LIMIT 1`,                                                   binds: (id) => [id] },
  { slice: "tags",                sql: `SELECT taxonomy FROM entity_tags WHERE entity_id = ? LIMIT 1`,                                            binds: (id) => [id] },
  { slice: "relationships_out",   sql: `SELECT id FROM rel_edges WHERE src_entity_id = ? LIMIT 1`,                                                binds: (id) => [id] },
  { slice: "relationships_in",    sql: `SELECT id FROM rel_edges WHERE dst_entity_id = ? LIMIT 1`,                                                binds: (id) => [id] },
  { slice: "news_mentions",       sql: `SELECT id FROM news_entity_mentions WHERE entity_id = ? LIMIT 1`,                                         binds: (id) => [id] },
  // getProfileAxes() reads entity_profile_axes — same table as the
  // envelope's classification slice (line 72 in profile.ts).
  { slice: "classification",      sql: `SELECT axis FROM entity_profile_axes WHERE entity_id = ? LIMIT 1`,                                        binds: (id) => [id] },
  { slice: "risk_scores",         sql: `SELECT entity_id FROM entity_risk_scores WHERE entity_id = ? LIMIT 1`,                                    binds: (id) => [id] },
  { slice: "predictions",         sql: `SELECT id FROM predictions WHERE entity_id = ? LIMIT 1`,                                                  binds: (id) => [id] },
  { slice: "summary",             sql: `SELECT entity_id FROM entity_summary WHERE entity_id = ? LIMIT 1`,                                        binds: (id) => [id] },
  { slice: "government_appointments", sql: `SELECT id FROM government_appointments WHERE entity_id = ? LIMIT 1`,                                  binds: (id) => [id] },
  { slice: "political_donations", sql: `SELECT id FROM political_donations WHERE entity_id = ? LIMIT 1`,                                          binds: (id) => [id] },
];

export async function runProfileHealthSlices(env: Env, id: string): Promise<SliceResult[]> {
  const out: SliceResult[] = [];
  for (const p of PROBES) {
    const t0 = Date.now();
    try {
      await env.DB.prepare(p.sql).bind(...p.binds(id)).first();
      out.push({ slice: p.slice, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      out.push({ slice: p.slice, ok: false, ms: Date.now() - t0, error: (e as Error).message });
    }
  }
  return out;
}
