// 90-day re-verification. For each active link older than 90 days, re-probe
// the canonical URL. On miss, demote (is_active=0, demoted_reason='reverify_miss').
// On hit, refresh last_verified_at.

import type { Env } from "../types";
import { getPlatform } from "./platforms";
import { simpleGet, bodyLooksLikeMiss } from "./pivots/_util";

export interface ReverifyResult {
  scanned: number;
  reverified: number;
  demoted: number;
  errored: number;
}

export async function reverifyDueHandles(env: Env, opts: { limit?: number; maxAgeDays?: number } = {}): Promise<ReverifyResult> {
  const limit = opts.limit ?? 200;
  const age = opts.maxAgeDays ?? 90;
  const result: ReverifyResult = { scanned: 0, reverified: 0, demoted: 0, errored: 0 };

  const due = await env.DB.prepare(
    `SELECT id, entity_id, platform, handle, url FROM identity_handles
      WHERE is_active = 1
        AND datetime(last_verified_at) < datetime('now', ?)
      ORDER BY last_verified_at ASC
      LIMIT ?`,
  ).bind(`-${age} days`, limit).all<{ id: string; entity_id: string; platform: string; handle: string; url: string | null }>();

  for (const row of due.results ?? []) {
    result.scanned++;
    const def = getPlatform(row.platform);
    if (!def) { result.errored++; continue; }

    const probeUrl = def.probeUrlOf ? def.probeUrlOf(row.handle) : (row.url ?? def.urlOf(row.handle));
    const res = await simpleGet(probeUrl, { timeoutMs: 5000, accept: def.probeUrlOf ? "application/json" : "text/html" });

    const miss =
      res.status === 404 ||
      (res.status >= 400 && res.status < 500 && res.status !== 429) ||
      (res.ok && bodyLooksLikeMiss(res.text, def.notFoundHints));

    if (!res.ok && res.status === 0) { result.errored++; continue; }

    if (miss) {
      await env.DB.prepare(
        `UPDATE identity_handles SET is_active = 0,
            demoted_reason = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).bind(`reverify_miss:${res.status}`, row.id).run();
      result.demoted++;
    } else if (res.ok) {
      await env.DB.prepare(
        `UPDATE identity_handles SET last_verified_at = datetime('now'),
            link_method = CASE WHEN link_method = 'reverify' THEN link_method ELSE link_method END,
            updated_at = datetime('now')
          WHERE id = ?`,
      ).bind(row.id).run();
      result.reverified++;
    } else {
      result.errored++;
    }
  }

  // Stamp the entity_state with last_reverify_at for observability.
  try {
    const seenEntities = new Set((due.results ?? []).map((r) => r.entity_id));
    for (const eid of seenEntities) {
      await env.DB.prepare(
        `INSERT INTO osint_entity_state (entity_id, last_reverify_at, updated_at)
         VALUES (?, datetime('now'), datetime('now'))
         ON CONFLICT(entity_id) DO UPDATE SET
           last_reverify_at = excluded.last_reverify_at,
           updated_at = datetime('now')`,
      ).bind(eid).run();
    }
  } catch { /* ignore */ }

  return result;
}
