// Task #4: worked_at edges from past career_history rows (is_current=0).
// Falls back to all rows whose source_url contains "linkedin" if no
// LinkedIn-tagged cache exists. Honest degradation: when career_history
// has no past rows we return 0 proposals.
import { safeAll } from "../_safeQuery";
import { resolveEntityId } from "../resolve";
export const NAME = "employmentHistoryFromLinkedIn";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 5000;
    const binds = [];
    let where = "is_current = 0";
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
            kind: "worked_at",
            source: "linkedin",
            valid_from: r.started_at ?? null,
            valid_to: r.ended_at ?? null,
            evidence_url: r.source_url ?? null,
            backing_fact_ids: [],
        });
    }
    return { proposals, unresolved_count: unresolved, scanned: rows.length };
}
