// Task #4: co_authored_with edges from publication_authors. Honest
// degradation: this table is not populated in current installs — the
// safeAll wrapper returns [] and the extractor reports 0 proposals.
import { safeAll } from "../_safeQuery";
export const NAME = "coAuthorFromPublications";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 500;
    const binds = [];
    let extra = "";
    if (opts.entityId) {
        extra = ` AND publication_id IN (SELECT publication_id FROM publication_authors WHERE entity_id = ?)`;
        binds.push(opts.entityId);
    }
    const rows = await safeAll(env, `SELECT publication_id, GROUP_CONCAT(DISTINCT entity_id) AS authors
       FROM publication_authors
      WHERE entity_id IS NOT NULL ${extra}
      GROUP BY publication_id HAVING COUNT(DISTINCT entity_id) > 1
      LIMIT ${limit}`, ...binds);
    const proposals = [];
    let scanned = 0;
    for (const r of rows) {
        const authors = Array.from(new Set((r.authors ?? "").split(",").filter(Boolean))).sort();
        scanned += authors.length;
        for (let i = 0; i < authors.length; i++) {
            for (let j = i + 1; j < authors.length; j++) {
                proposals.push({
                    src_entity_id: authors[i], dst_entity_id: authors[j],
                    kind: "co_authored_with", source: "publication",
                    backing_fact_ids: [r.publication_id],
                });
            }
        }
    }
    return { proposals, unresolved_count: 0, scanned };
}
