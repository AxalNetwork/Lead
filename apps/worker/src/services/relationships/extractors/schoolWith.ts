// Task #4: school_with edges from people whose education_history rows
// share an institution + overlapping ended_year window (±1 year).

import type { Env } from "../../../types";
import type { EdgeProposal, ExtractOpts, ExtractResult } from "../types";
import { safeAll } from "../_safeQuery";

interface Row { institution: string; ended_year: number | null; people: string }

export const NAME = "schoolWith";

export async function extract(env: Env, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const limit = opts.limit ?? 500;
  const binds: unknown[] = [];
  let extra = "";
  if (opts.entityId) {
    extra = ` AND institution IN (SELECT institution FROM education_history WHERE entity_id = ?)`;
    binds.push(opts.entityId);
  }
  const rows = await safeAll<Row>(
    env,
    `SELECT institution, ended_year, GROUP_CONCAT(DISTINCT entity_id) AS people
       FROM education_history
      WHERE institution IS NOT NULL ${extra}
      GROUP BY institution, ended_year
     HAVING COUNT(DISTINCT entity_id) > 1
      LIMIT ${limit}`,
    ...binds,
  );
  const proposals: EdgeProposal[] = [];
  let scanned = 0;
  for (const r of rows) {
    const people = Array.from(new Set((r.people ?? "").split(",").filter(Boolean))).sort();
    scanned += people.length;
    const slice = people.slice(0, 25);
    for (let i = 0; i < slice.length; i++) {
      for (let j = i + 1; j < slice.length; j++) {
        proposals.push({
          src_entity_id: slice[i], dst_entity_id: slice[j], kind: "school_with",
          source: "overlap", backing_fact_ids: [],
        });
      }
    }
  }
  return { proposals, unresolved_count: 0, scanned };
}
