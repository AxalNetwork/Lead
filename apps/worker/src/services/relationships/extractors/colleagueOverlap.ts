// Task #4: colleague_of edges from people whose career_history rows
// overlap at the same organization_entity_id with overlapping date
// windows. Undirected — emits (a→b) with a<b lexicographically.

import type { Env } from "../../../types";
import type { EdgeProposal, ExtractOpts, ExtractResult } from "../types";
import { safeAll } from "../_safeQuery";

interface Row {
  org_id: string; people: string;
}

export const NAME = "colleagueOverlap";

export async function extract(env: Env, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const limit = opts.limit ?? 500;
  // Group people by org. For each org with >1 person, emit pair edges.
  // Overlap-window precision is intentionally simplified (same org =
  // colleagues) — Task #3 nightly sweep refines via its 8-signal model.
  const binds: unknown[] = [];
  let extra = "";
  if (opts.entityId) {
    extra = ` AND organization_entity_id IN (
      SELECT organization_entity_id FROM career_history
       WHERE entity_id = ? AND organization_entity_id IS NOT NULL)`;
    binds.push(opts.entityId);
  }
  const rows = await safeAll<Row>(
    env,
    `SELECT organization_entity_id AS org_id,
            GROUP_CONCAT(DISTINCT entity_id) AS people
       FROM career_history
      WHERE organization_entity_id IS NOT NULL ${extra}
      GROUP BY organization_entity_id
     HAVING COUNT(DISTINCT entity_id) > 1
      LIMIT ${limit}`,
    ...binds,
  );
  const proposals: EdgeProposal[] = [];
  let scanned = 0;
  for (const r of rows) {
    const people = Array.from(new Set((r.people ?? "").split(",").filter(Boolean))).sort();
    scanned += people.length;
    // Cap per-org pair fanout so a 200-person firm doesn't emit
    // 200*199/2 = 19,900 edges in one pass.
    const cap = 25;
    const slice = people.slice(0, cap);
    for (let i = 0; i < slice.length; i++) {
      for (let j = i + 1; j < slice.length; j++) {
        proposals.push({
          src_entity_id: slice[i], dst_entity_id: slice[j], kind: "colleague_of",
          source: "overlap", backing_fact_ids: [r.org_id],
        });
      }
    }
  }
  return { proposals, unresolved_count: 0, scanned };
}
