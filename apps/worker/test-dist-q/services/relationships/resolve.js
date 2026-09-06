// Task #4 (Relationship Inference Worker): entity resolution helper.
//
// Right-hand-side strings ("Sequoia", "Stripe", "Harvard") route through
// this single helper which calls `resolveSecEntity({createIfMissing:false})`
// under the hood. Extractors never mint raw u_entities — unresolved
// strings are dropped and reported via the orchestrator summary, per
// the Task #18 charter-investor precedent.
import { resolveSecEntity } from "../secEdgar/xref";
const cache = new Map();
function cacheKey(kind, name) {
    return `${kind}|${name.trim().toLowerCase()}`;
}
/**
 * Resolve a free-text name + kind to an existing u_entities.id.
 * Returns null if no entity matches — callers MUST treat null as
 * "drop this proposal and bump unresolved_count".
 *
 * The resolver intentionally passes `createIfMissing: false` to
 * `resolveSecEntity` so legal-prose / scrape-noise names cannot
 * mint fresh entities.
 */
export async function resolveEntityId(env, name, kind, jurisdiction) {
    const trimmed = (name ?? "").trim();
    if (!trimmed)
        return null;
    const key = cacheKey(kind, trimmed);
    if (cache.has(key))
        return cache.get(key) ?? null;
    let id = null;
    try {
        const r = await resolveSecEntity(env, {
            name: trimmed,
            kind,
            jurisdiction: jurisdiction ?? null,
            source: "relationships:resolve",
            createIfMissing: false,
        });
        id = r?.entity_id ?? null;
    }
    catch {
        id = null;
    }
    // Last-resort fallback: a direct lookup by primary_domain when the
    // input looks like a host (so portfolio-page extractors that scrape
    // "stripe.com" can match an org whose primary_domain is stripe.com).
    if (!id && /\./.test(trimmed) && !trimmed.includes(" ")) {
        try {
            const r = await env.DB.prepare(`SELECT id FROM u_entities WHERE primary_domain = ? AND kind = ? LIMIT 1`).bind(trimmed.toLowerCase(), kind).first();
            id = r?.id ?? null;
        }
        catch { /* swallow */ }
    }
    cache.set(key, id);
    return id;
}
export function clearResolveCache() {
    cache.clear();
}
