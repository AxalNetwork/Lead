// Task #4: advises edges from facts whose predicate carries an
// "advisor"/"advises" hint. value_entity_id is preferred; value_text
// goes through resolveEntityId (createIfMissing:false).
import { safeAll } from "../_safeQuery";
import { resolveEntityId } from "../resolve";
export const NAME = "advisorFromBio";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 5000;
    const binds = [];
    let where = "(predicate LIKE '%advisor%' OR predicate LIKE '%advises%') AND is_current = 1";
    if (opts.entityId) {
        where += " AND entity_id = ?";
        binds.push(opts.entityId);
    }
    if (opts.since) {
        where += " AND observed_at >= ?";
        binds.push(opts.since);
    }
    const rows = await safeAll(env, `SELECT id, entity_id, value_entity_id, value_text, evidence_url, observed_at
       FROM facts WHERE ${where} LIMIT ${limit}`, ...binds);
    const proposals = [];
    let unresolved = 0;
    for (const f of rows) {
        let dst = f.value_entity_id;
        if (!dst && f.value_text)
            dst = await resolveEntityId(env, f.value_text, "org");
        if (!dst) {
            unresolved += 1;
            continue;
        }
        proposals.push({
            src_entity_id: f.entity_id, dst_entity_id: dst, kind: "advises", source: "bio",
            valid_from: f.observed_at ?? null, evidence_url: f.evidence_url ?? null,
            backing_fact_ids: [f.id],
        });
    }
    return { proposals, unresolved_count: unresolved, scanned: rows.length };
}
