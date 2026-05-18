// Task #3 (third-pass review fix): smart_frontier -> crawl_frontier bridge.
//
// The smart frontier is a typed, priority-ranked staging area. The actual
// crawler queue (Task #2) is the url_id-keyed `crawl_frontier` table.
// This drainer pops the top-priority queued rows from smart_frontier,
// upserts them through Task #2's `upsertDiscoveredUrl` so they get a
// proper url_id, enqueues them into crawl_frontier with the smart
// priority, and marks the smart_frontier row as 'enqueued'.
//
// Deterministic ordering (priority DESC, discovered_at ASC) means a
// re-tick within the same window picks up where the last one left off.

import type { Env } from "../../types";
import { upsertDiscoveredUrl, enqueueFrontier } from "../../discovery/store.discovery";

interface SmartRow {
  id: string;
  url: string;
  url_canonical: string;
  host: string;
  profile_type_id: string | null;
  discovery_reason: string;
  priority: number;
  source_url: string | null;
}

export interface DrainResult {
  picked: number;
  enqueued: number;
  rejected: number;
  errors: number;
}

export async function drainSmartFrontier(env: Env, limit = 200): Promise<DrainResult> {
  const out: DrainResult = { picked: 0, enqueued: 0, rejected: 0, errors: 0 };
  const rows = await env.DB.prepare(
    `SELECT id, url, url_canonical, host, profile_type_id, discovery_reason, priority, source_url
       FROM smart_frontier
      WHERE status = 'queued'
      ORDER BY priority DESC, discovered_at ASC
      LIMIT ?`,
  ).bind(limit).all<SmartRow>();
  const list = rows.results ?? [];
  out.picked = list.length;

  for (const row of list) {
    try {
      const up = await upsertDiscoveredUrl(env, {
        url: row.url,
        discoveredFromUrl: row.source_url ?? null,
        discoveredFromId: null,
        discoveryMethod: `smart_frontier:${row.discovery_reason}`,
        depth: 1,
        linkText: null,
        likelyKind: null,
        expectedYieldScore: row.priority,
        jobId: null,
      });
      if (!up) { out.errors++; continue; }
      if (up.rejected) {
        out.rejected++;
        await env.DB.prepare(
          `UPDATE smart_frontier SET status = 'rejected', enqueued_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ).bind(row.id).run();
        continue;
      }
      const { inserted } = await enqueueFrontier(env, up.id, row.priority, null);
      await env.DB.prepare(
        `UPDATE smart_frontier
            SET status = 'enqueued',
                enqueued_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      ).bind(row.id).run();
      if (inserted) out.enqueued++;
    } catch (e) {
      out.errors++;
      console.warn("drainSmartFrontier row failed", row.id, (e as Error).message);
    }
  }
  return out;
}
