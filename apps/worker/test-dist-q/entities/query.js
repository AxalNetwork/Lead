// High-level read helpers. `loadEntity` returns the canonical envelope
// every consumer can rely on; `searchEntities` is a thin filter DSL that
// joins entity_summary + entity_tags for sub-50ms list responses.
import { getEffectiveFacts, loadCurrentOverrides } from "./facts";
export async function loadEntity(env, id, opts) {
    const ent = await env.DB.prepare(`SELECT * FROM u_entities WHERE id = ?`).bind(id).first();
    if (!ent)
        return null;
    // Task #3 (Editable Profiles): use the SAME shared resolver as the
    // summary rebuilder so the two read sites cannot drift. The resolver
    // returns one EffectiveFact list with canonical rows + dethroned
    // attempts marked overridden_attempt=true; we split that into
    // facts[] (canonical) and attempts[] (diff strip).
    const [roles, effective, channels, tags, summary, overridesMap] = await Promise.all([
        env.DB.prepare(`SELECT role, is_primary, confidence FROM entity_roles WHERE entity_id = ?`).bind(id).all(),
        getEffectiveFacts(env, id, { includeNonCurrent: !!opts?.includeNonCurrent, limit: 500 }),
        env.DB.prepare(`SELECT kind, canonical, display, is_primary, is_verified, is_dnc FROM channels WHERE entity_id = ?`).bind(id).all(),
        env.DB.prepare(`SELECT taxonomy, slug, weight FROM entity_tags WHERE entity_id = ?`).bind(id).all(),
        env.DB.prepare(`SELECT * FROM entity_summary WHERE entity_id = ?`).bind(id).first(),
        loadCurrentOverrides(env, id),
    ]);
    const factRows = [];
    const attempts = [];
    for (const e of effective) {
        const row = {
            id: e.id, predicate: e.predicate,
            value_text: e.value_text, value_number: e.value_number,
            value_json: e.value_json, value_entity_id: e.value_entity_id,
            source: e.source, source_kind: e.source_kind,
            confidence: e.confidence, verified_score: e.verified_score,
            observed_at: e.observed_at, is_current: e.is_current,
            superseded_by_override: e.superseded_by_override,
        };
        if (e.overridden_attempt)
            attempts.push(row);
        else
            factRows.push(row);
    }
    const overrideArr = Array.from(overridesMap.values()).map((ov) => ({
        id: ov.id,
        predicate: ov.predicate,
        value_text: ov.value_text,
        value_number: ov.value_numeric,
        value_json: ov.value_json ? (() => { try {
            return JSON.parse(ov.value_json);
        }
        catch {
            return ov.value_json;
        } })() : null,
        overridden_at: ov.overridden_at,
    }));
    return {
        id, kind: ent.kind, entity: ent,
        roles: (roles.results ?? []),
        facts: factRows,
        attempts,
        channels: (channels.results ?? []),
        tags: (tags.results ?? []),
        summary: summary ?? null,
        overrides: overrideArr,
    };
}
export async function searchEntities(env, f) {
    // IMPORTANT: bind order must match SQL placeholder order. Since the
    // tag JOINs appear *before* the WHERE clause in the final SQL, their
    // binds must be pushed first. We build two separate bind arrays and
    // concatenate them in SQL order at the end.
    const joinBinds = [];
    const whereBinds = [];
    const where = ["s.status = 'active'"];
    if (f.kind) {
        where.push("s.kind = ?");
        whereBinds.push(f.kind);
    }
    if (f.role) {
        where.push("s.primary_role = ?");
        whereBinds.push(f.role);
    }
    if (f.country_iso2) {
        where.push("s.country_iso2 = ?");
        whereBinds.push(f.country_iso2.toUpperCase());
    }
    if (typeof f.check_min_usd === "number") {
        where.push("s.check_size_max_usd >= ?");
        whereBinds.push(f.check_min_usd);
    }
    if (typeof f.check_max_usd === "number") {
        where.push("s.check_size_min_usd <= ?");
        whereBinds.push(f.check_max_usd);
    }
    if (f.has_unicorn) {
        where.push("s.unicorn_count > 0");
    }
    if (typeof f.min_fit === "number") {
        where.push("s.fit_max_score >= ?");
        whereBinds.push(f.min_fit);
    }
    if (typeof f.min_intent === "number") {
        where.push("s.intent_score >= ?");
        whereBinds.push(f.min_intent);
    }
    if (f.q) {
        where.push("(lower(s.display_name) LIKE ? OR lower(s.primary_domain) LIKE ? OR lower(s.primary_email) LIKE ?)");
        const q = `%${f.q.toLowerCase()}%`;
        whereBinds.push(q, q, q);
    }
    // Tag filters require a JOIN per taxonomy so we can intersect.
    // NOTE: `has_role` is *not* a tag — roles live in entity_roles
    // (addRole writes there, not entity_tags). The previous JOIN on
    // entity_tags taxonomy='role' returned empty results for every
    // wrapper helper (listFirms, listInvestors, listCompanies,
    // listAccounts, listBuyers, listFounders). We now JOIN entity_roles
    // directly for role membership.
    const joins = [];
    let tagJoinIdx = 0;
    for (const [tax, slug] of [["sector", f.sector], ["stage", f.stage], ["geo", f.geo]]) {
        if (!slug)
            continue;
        const alias = `t${++tagJoinIdx}`;
        joins.push(`JOIN entity_tags ${alias} ON ${alias}.entity_id = s.entity_id AND ${alias}.taxonomy = ? AND ${alias}.slug = ?`);
        joinBinds.push(tax, slug);
    }
    if (f.has_role) {
        joins.push(`JOIN entity_roles er ON er.entity_id = s.entity_id AND er.role = ?`);
        joinBinds.push(f.has_role);
    }
    const sortCol = (() => {
        switch (f.sort) {
            case "intent": return "s.intent_score DESC";
            case "quality": return "s.quality_score DESC";
            case "updated": return "s.rebuilt_at DESC";
            default: return "s.fit_max_score DESC";
        }
    })();
    const limit = Math.min(Math.max(1, f.limit ?? 50), 200);
    const offset = Math.max(0, f.offset ?? 0);
    const sql = `SELECT s.* FROM entity_summary s ${joins.join(" ")}
               WHERE ${where.join(" AND ")}
               ORDER BY ${sortCol}, s.entity_id ASC
               LIMIT ? OFFSET ?`;
    const r = await env.DB.prepare(sql).bind(...joinBinds, ...whereBinds, limit + 1, offset).all();
    const rows = r.results ?? [];
    const hasMore = rows.length > limit;
    return {
        items: (hasMore ? rows.slice(0, limit) : rows),
        next_offset: hasMore ? offset + limit : null,
    };
}
export const listFirms = (env, f = {}) => searchEntities(env, { ...f, kind: "org", has_role: f.has_role ?? "firm" });
export const listInvestors = (env, f = {}) => searchEntities(env, { ...f, kind: "person", has_role: "investor" });
export const listCompanies = (env, f = {}) => searchEntities(env, { ...f, kind: "org", has_role: f.has_role ?? "company" });
export const listAccounts = (env, f = {}) => searchEntities(env, { ...f, kind: "org", has_role: "account" });
export const listBuyers = (env, f = {}) => searchEntities(env, { ...f, kind: "person", has_role: "buyer" });
export const listFounders = (env, f = {}) => searchEntities(env, { ...f, kind: "person", has_role: "founder" });
