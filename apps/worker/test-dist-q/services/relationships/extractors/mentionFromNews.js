// Task #4: publicly_mentioned_with edges from news_entity_mentions —
// two entities mentioned in the same news_item. Edges are undirected;
// the pair-fanout cap bounds CPU on a hub story (e.g. an industry
// roundup with 50 names).
import { safeAll } from "../_safeQuery";
export const NAME = "mentionFromNews";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 1000;
    const binds = [];
    let extra = "";
    if (opts.entityId) {
        extra = ` AND news_item_id IN (SELECT news_item_id FROM news_entity_mentions WHERE entity_id = ?)`;
        binds.push(opts.entityId);
    }
    if (opts.since) {
        extra += " AND detected_at >= ?";
        binds.push(opts.since);
    }
    const rows = await safeAll(env, `SELECT news_item_id, GROUP_CONCAT(DISTINCT entity_id) AS entities
       FROM news_entity_mentions WHERE 1=1 ${extra}
      GROUP BY news_item_id HAVING COUNT(DISTINCT entity_id) > 1
      LIMIT ${limit}`, ...binds);
    const proposals = [];
    let scanned = 0;
    for (const r of rows) {
        const ents = Array.from(new Set((r.entities ?? "").split(",").filter(Boolean))).sort();
        scanned += ents.length;
        const slice = ents.slice(0, 15);
        for (let i = 0; i < slice.length; i++) {
            for (let j = i + 1; j < slice.length; j++) {
                proposals.push({
                    src_entity_id: slice[i], dst_entity_id: slice[j],
                    kind: "publicly_mentioned_with", source: "news",
                    backing_fact_ids: [r.news_item_id],
                });
            }
        }
    }
    return { proposals, unresolved_count: 0, scanned };
}
