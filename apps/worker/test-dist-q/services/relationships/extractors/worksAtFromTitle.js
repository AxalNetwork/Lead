// Task #4: works_at edges from current title rows in career_history.
//
// Source: career_history WHERE is_current=1. Right-hand-side org is
// resolved through services/relationships/resolve.ts (createIfMissing:false);
// rows whose organization_name doesn't resolve are dropped and counted
// under unresolved_count.
import { safeAll } from "../_safeQuery";
import { resolveEntityId } from "../resolve";
export const NAME = "worksAtFromTitle";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 5000;
    const binds = [];
    let where = "is_current = 1";
    if (opts.entityId) {
        where += " AND entity_id = ?";
        binds.push(opts.entityId);
    }
    if (opts.since) {
        where += " AND COALESCE(updated_at, observed_at) >= ?";
        binds.push(opts.since);
    }
    const rows = await safeAll(env, `SELECT id, entity_id, organization_entity_id, organization_name, started_at, ended_at, source_url
       FROM career_history WHERE ${where} LIMIT ${limit}`, ...binds);
    const proposals = [];
    let unresolved = 0;
    for (const r of rows) {
        let dst = r.organization_entity_id;
        if (!dst)
            dst = await resolveEntityId(env, r.organization_name, "org");
        if (!dst) {
            unresolved += 1;
            continue;
        }
        proposals.push({
            src_entity_id: r.entity_id,
            dst_entity_id: dst,
            kind: "works_at",
            source: "title",
            valid_from: r.started_at ?? null,
            valid_to: r.ended_at ?? null,
            evidence_url: r.source_url ?? null,
            backing_fact_ids: [],
        });
    }
    return { proposals, unresolved_count: unresolved, scanned: rows.length };
}
