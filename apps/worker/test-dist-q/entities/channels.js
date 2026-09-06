// Channel upsert keyed by (entity_id, kind, canonical). Canonical form
// is computed by ./normalize so trivially-different inputs collapse.
import { canonicalEmail, canonicalPhone, canonicalLinkedin, canonicalTwitter, canonicalGithub, canonicalUrl, } from "./normalize";
export function canonicalizeFor(kind, raw) {
    switch (kind) {
        case "email": return canonicalEmail(raw);
        case "phone": return canonicalPhone(raw);
        case "linkedin": return canonicalLinkedin(raw);
        case "twitter": return canonicalTwitter(raw);
        case "github": return canonicalGithub(raw);
        case "website":
        case "other":
            return canonicalUrl(raw);
    }
}
export async function upsertChannel(env, input) {
    if (!input.entity_id || !input.canonical)
        return null;
    // Re-canonicalize defensively in case caller passed a raw value.
    const canonical = canonicalizeFor(input.kind, input.canonical) ?? input.canonical;
    const now = new Date().toISOString();
    const existing = await env.DB.prepare(`SELECT id FROM channels WHERE entity_id = ? AND kind = ? AND canonical = ?`).bind(input.entity_id, input.kind, canonical).first();
    if (existing) {
        const sets = ["last_seen_at = ?"];
        const binds = [now];
        if (input.display) {
            sets.push("display = COALESCE(display, ?)");
            binds.push(input.display);
        }
        if (input.is_primary) {
            sets.push("is_primary = 1");
        }
        if (input.is_verified) {
            sets.push("is_verified = 1");
        }
        if (input.is_dnc) {
            sets.push("is_dnc = 1");
        }
        if (input.source) {
            sets.push("source = COALESCE(source, ?)");
            binds.push(input.source);
        }
        binds.push(existing.id);
        await env.DB.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        return existing.id;
    }
    const id = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO channels (id, entity_id, kind, canonical, display, is_primary, is_verified, is_dnc, source, confidence, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, input.entity_id, input.kind, canonical, input.display ?? null, input.is_primary ? 1 : 0, input.is_verified ? 1 : 0, input.is_dnc ? 1 : 0, input.source ?? null, input.confidence ?? 1, now, now).run();
    return id;
}
export async function findEntityByChannel(env, kind, raw) {
    const canonical = canonicalizeFor(kind, raw);
    if (!canonical)
        return null;
    const r = await env.DB.prepare(`SELECT c.entity_id FROM channels c
     JOIN u_entities e ON e.id = c.entity_id
     WHERE c.kind = ? AND c.canonical = ? AND e.status NOT IN ('merged','soft_deleted')
     ORDER BY c.is_primary DESC, c.is_verified DESC, c.last_seen_at DESC LIMIT 1`).bind(kind, canonical).first();
    return r?.entity_id ?? null;
}
