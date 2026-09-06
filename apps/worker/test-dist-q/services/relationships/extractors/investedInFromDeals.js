// Task #4: invested_in edges from deal_participants → deal_events.
// Source tag is "sec.form_d" for sec_filing rows, "press" otherwise,
// driving the baseline quality_score lookup. Unresolved investors or
// companies (no entity id and resolveEntityId returns null) are dropped.
import { safeAll } from "../_safeQuery";
import { resolveEntityId } from "../resolve";
export const NAME = "investedInFromDeals";
export async function extract(env, opts = {}) {
    const limit = opts.limit ?? 5000;
    const binds = [];
    let where = "1=1";
    if (opts.entityId) {
        where += " AND (dp.investor_entity_id = ? OR de.company_entity_id = ?)";
        binds.push(opts.entityId, opts.entityId);
    }
    if (opts.since) {
        where += " AND COALESCE(de.updated_at, de.created_at) >= ?";
        binds.push(opts.since);
    }
    const rows = await safeAll(env, `SELECT dp.id AS participant_id, dp.deal_id, dp.investor_entity_id, dp.investor_name_raw,
            de.company_entity_id, de.company_name_raw, de.source_type, de.source_url, de.announcement_date
       FROM deal_participants dp JOIN deal_events de ON de.id = dp.deal_id
      WHERE ${where} LIMIT ${limit}`, ...binds);
    const proposals = [];
    let unresolved = 0;
    for (const r of rows) {
        let investor = r.investor_entity_id;
        if (!investor)
            investor = await resolveEntityId(env, r.investor_name_raw, "org");
        let company = r.company_entity_id;
        if (!company)
            company = await resolveEntityId(env, r.company_name_raw, "org");
        if (!investor || !company) {
            unresolved += 1;
            continue;
        }
        const source = r.source_type === "sec_filing" ? "sec" : (r.source_type === "press_release" ? "press" : "press");
        proposals.push({
            src_entity_id: investor,
            dst_entity_id: company,
            kind: "invested_in",
            source,
            valid_from: r.announcement_date ?? null,
            evidence_url: r.source_url ?? null,
            backing_fact_ids: [],
        });
    }
    return { proposals, unresolved_count: unresolved, scanned: rows.length };
}
