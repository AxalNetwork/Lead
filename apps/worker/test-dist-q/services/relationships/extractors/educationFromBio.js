// Task #4: studied_at edges from education_history. Institution name is
// resolved (createIfMissing:false) — unresolved institutions are dropped.
import { safeAll } from "../_safeQuery";
import { resolveEntityId } from "../resolve";
export const NAME = "educationFromBio";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 5000;
    const binds = [];
    let where = "institution IS NOT NULL AND institution != ''";
    if (opts.entityId) {
        where += " AND entity_id = ?";
        binds.push(opts.entityId);
    }
    if (opts.since) {
        where += " AND COALESCE(updated_at, observed_at) >= ?";
        binds.push(opts.since);
    }
    const rows = await safeAll(env, `SELECT id, entity_id, institution, started_year, ended_year, source_url
       FROM education_history WHERE ${where} LIMIT ${limit}`, ...binds);
    const proposals = [];
    let unresolved = 0;
    for (const r of rows) {
        const dst = await resolveEntityId(env, r.institution, "org");
        if (!dst) {
            unresolved += 1;
            continue;
        }
        proposals.push({
            src_entity_id: r.entity_id, dst_entity_id: dst, kind: "studied_at", source: "bio",
            valid_from: r.started_year != null ? `${r.started_year}-01-01` : null,
            valid_to: r.ended_year != null ? `${r.ended_year}-12-31` : null,
            evidence_url: r.source_url ?? null, backing_fact_ids: [],
        });
    }
    return { proposals, unresolved_count: unresolved, scanned: rows.length };
}
