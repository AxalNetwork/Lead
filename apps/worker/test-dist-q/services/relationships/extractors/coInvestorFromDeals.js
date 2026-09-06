// Task #4: co_invested_with edges from pairs of resolved investors on
// the same deal. Pairs are undirected — emit (a→b) with a<b to keep
// the unique index from inserting both directions as separate edges.
import { safeAll } from "../_safeQuery";
export const NAME = "coInvestorFromDeals";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 2000;
    const binds = [];
    let extra = "";
    if (opts.entityId) {
        extra = ` AND deal_id IN (SELECT deal_id FROM deal_participants WHERE investor_entity_id = ?)`;
        binds.push(opts.entityId);
    }
    if (opts.since) {
        extra += ` AND deal_id IN (SELECT id FROM deal_events WHERE COALESCE(updated_at,created_at) >= ?)`;
        binds.push(opts.since);
    }
    const rows = await safeAll(env, `SELECT deal_id, GROUP_CONCAT(investor_entity_id) AS investors
       FROM deal_participants
      WHERE investor_entity_id IS NOT NULL ${extra}
      GROUP BY deal_id HAVING COUNT(DISTINCT investor_entity_id) > 1
      LIMIT ${limit}`, ...binds);
    const proposals = [];
    let scanned = 0;
    for (const r of rows) {
        const investors = Array.from(new Set((r.investors ?? "").split(",").filter(Boolean)));
        investors.sort();
        scanned += investors.length;
        for (let i = 0; i < investors.length; i++) {
            for (let j = i + 1; j < investors.length; j++) {
                proposals.push({
                    src_entity_id: investors[i],
                    dst_entity_id: investors[j],
                    kind: "co_invested_with",
                    source: "deal",
                    backing_fact_ids: [r.deal_id],
                });
            }
        }
    }
    return { proposals, unresolved_count: 0, scanned };
}
