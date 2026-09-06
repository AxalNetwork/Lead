// Task #4: family_of edges from family_ties WHERE is_public = 1.
// Only public-source rows ingest — private records are out of scope
// per the spec's explicit "family / personal edges … only ingest from
// explicitly public sources" constraint. Related-name strings are
// resolved (createIfMissing:false); unresolved names are dropped.
import { safeAll } from "../_safeQuery";
import { resolveEntityId } from "../resolve";
export const NAME = "familyFromPublicSources";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 2000;
    const binds = [];
    let where = "is_public = 1";
    if (opts.entityId) {
        where += " AND entity_id = ?";
        binds.push(opts.entityId);
    }
    if (opts.since) {
        where += " AND COALESCE(updated_at, observed_at) >= ?";
        binds.push(opts.since);
    }
    const rows = await safeAll(env, `SELECT id, entity_id, related_entity_id, related_name, notes
       FROM family_ties WHERE ${where} LIMIT ${limit}`, ...binds);
    const proposals = [];
    let unresolved = 0;
    for (const r of rows) {
        let dst = r.related_entity_id;
        if (!dst)
            dst = await resolveEntityId(env, r.related_name, "person");
        if (!dst) {
            unresolved += 1;
            continue;
        }
        const tag = (r.notes ?? "").toLowerCase().includes("wedding") ? "wedding_notice" : "tweet";
        proposals.push({
            src_entity_id: r.entity_id, dst_entity_id: dst, kind: "family_of",
            source: tag, backing_fact_ids: [],
        });
    }
    return { proposals, unresolved_count: unresolved, scanned: rows.length };
}
