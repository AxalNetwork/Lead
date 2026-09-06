import { extractDomain } from "./normalize";
import { syncFirmToEntity } from "../entities/dualwrite";
const SCALAR_FIELDS = [
    "legal_name", "kind", "website", "logo_url",
    "hq_country_iso2", "hq_region", "hq_city",
    "thesis", "check_size_min_usd", "check_size_max_usd", "check_size_typical_usd",
    "aum_usd", "fund_count", "current_fund_name", "current_fund_size_usd",
    "lead_or_co", "portfolio_count", "founded_year", "team_size",
    "linkedin_url", "crunchbase_url", "twitter_handle",
    "signal_nfx_url", "openvc_url", "pitchbook_url",
    "contact_email", "submission_url",
];
// `source_url` is intentionally excluded from SCALAR_FIELDS — Task #1
// requires that re-imports from different Folk shares union the
// provenance URLs at the firm row level rather than fill-if-empty. The
// merge path below comma-joins distinct values (mirrors `imported_from`).
const ARRAY_FIELDS = [
    { key: "geo_focus", column: "geo_focus_json" },
    { key: "stages", column: "stages_json" },
    { key: "sectors", column: "sectors_json" },
    { key: "notable_investments", column: "notable_investments_json" },
];
export async function upsertFirm(env, candidate, importedFrom, 
/**
 * Task #1: optional dual-write provenance override. Folk-share imports
 * pass `{ source: 'folk_share', sourceKind: 'import' }` so the firm's
 * unified-graph facts carry import provenance instead of the default
 * `source_kind='scrape'`.
 */
importCtx) {
    const name = candidate.name?.trim();
    if (!name)
        throw new Error("upsertFirm: candidate.name required");
    const rawDomain = candidate.domain ?? deriveDomain(candidate.website);
    const domain = rawDomain ? rawDomain.toLowerCase().trim() : null;
    if (domain)
        candidate.domain = domain;
    // Quality gate: require name + (domain OR website). Without either,
    // dedupe is impossible and reruns would create endless duplicates.
    if (!domain && !candidate.website) {
        throw new Error("upsertFirm: candidate must have domain or website");
    }
    const lname = name.toLowerCase();
    // Dedupe lookup. Match on the effective domain (stored.domain coalesced
    // with the parsed hostname of stored.website) so a rerun that supplies
    // a domain still merges with a row that originally only had a website.
    const candidates = await env.DB.prepare("SELECT * FROM firms WHERE lower(name) = ? LIMIT 50").bind(lname).all();
    const rows = candidates.results ?? [];
    let existing = null;
    for (const r of rows) {
        const storedDomain = r.domain ?? deriveDomain(r.website ?? undefined);
        if (domain && storedDomain && storedDomain.toLowerCase() === domain) {
            existing = r;
            break;
        }
        if (!domain && !storedDomain) {
            existing = r;
            break;
        }
    }
    const result = existing
        ? await mergeInto(env, existing, candidate, importedFrom)
        : await insertNew(env, candidate, domain, importedFrom);
    // Task #4: dual-write into the unified entity graph (best-effort —
    // never block the legacy firm-list importer on a unified-model error).
    try {
        await syncFirmToEntity(env, {
            id: result.firmId,
            name: candidate.name,
            legal_name: candidate.legal_name ?? null,
            website: result.website,
            domain: result.domain,
            hq_country_iso2: candidate.hq_country_iso2 ?? null,
            hq_region: candidate.hq_region ?? null,
            hq_city: candidate.hq_city ?? null,
            check_size_min_usd: candidate.check_size_min_usd ?? null,
            check_size_max_usd: candidate.check_size_max_usd ?? null,
            check_size_typical_usd: candidate.check_size_typical_usd ?? null,
            thesis: candidate.thesis ?? null,
            linkedin_url: candidate.linkedin_url ?? null,
            crunchbase_url: candidate.crunchbase_url ?? null,
            twitter_handle: candidate.twitter_handle ?? null,
            contact_email: candidate.contact_email ?? null,
            sectors_json: candidate.sectors ? JSON.stringify(candidate.sectors) : null,
            stages_json: candidate.stages ? JSON.stringify(candidate.stages) : null,
            geo_focus_json: candidate.geo_focus ? JSON.stringify(candidate.geo_focus) : null,
            kind: candidate.kind ?? null,
        }, importCtx?.source ?? importedFrom, importCtx?.sourceKind ?? "scrape");
    }
    catch (e) {
        console.warn("dualwrite syncFirmToEntity failed", result.firmId, e.message);
    }
    // Role inference now runs centrally inside syncFirmToEntity (the
    // unified entity write path), so we no longer call it here.
    return result;
}
async function insertNew(env, c, domain, importedFrom) {
    const slug = await pickUniqueSlug(env, c.name, domain);
    const cols = ["name", "slug", "domain", "imported_from", "last_modified"];
    const vals = [c.name.trim(), slug, domain, importedFrom, new Date().toISOString()];
    for (const f of SCALAR_FIELDS) {
        const v = c[f];
        if (v != null && v !== "") {
            cols.push(f);
            vals.push(v);
        }
    }
    for (const { key, column } of ARRAY_FIELDS) {
        const v = c[key];
        if (v && v.length) {
            cols.push(column);
            vals.push(JSON.stringify(uniqStringArray(v)));
        }
    }
    if (c.source_url) {
        cols.push("source_url");
        vals.push(c.source_url);
    }
    if (c.socials) {
        cols.push("socials_json");
        vals.push(JSON.stringify(c.socials));
    }
    if (c.notes) {
        cols.push("notes");
        vals.push(c.notes);
    }
    const placeholders = cols.map(() => "?").join(",");
    const r = await env.DB.prepare(`INSERT INTO firms (${cols.join(",")}) VALUES (${placeholders})`).bind(...vals).run();
    const firmId = Number(r.meta.last_row_id);
    return { firmId, action: "created", website: c.website ?? null, domain };
}
async function mergeInto(env, existing, c, importedFrom) {
    const sets = [];
    const binds = [];
    // Scalar: only fill missing values; existing non-null values win.
    for (const f of SCALAR_FIELDS) {
        const newVal = c[f];
        if (newVal == null || newVal === "")
            continue;
        if (existing[f] == null || existing[f] === "") {
            sets.push(`${f} = ?`);
            binds.push(newVal);
        }
    }
    // Array fields: set-union of existing JSON array + new entries.
    for (const { key, column } of ARRAY_FIELDS) {
        const incoming = c[key];
        if (!incoming || !incoming.length)
            continue;
        const existingArr = parseJsonArray(existing[column]);
        const merged = uniqStringArray([...existingArr, ...incoming]);
        if (merged.length !== existingArr.length) {
            sets.push(`${column} = ?`);
            binds.push(JSON.stringify(merged));
        }
    }
    if (c.socials) {
        const existingSocials = parseJsonObject(existing.socials_json);
        const merged = { ...existingSocials, ...c.socials };
        if (Object.keys(merged).length !== Object.keys(existingSocials).length) {
            sets.push("socials_json = ?");
            binds.push(JSON.stringify(merged));
        }
    }
    if (c.notes && !existing.notes) {
        sets.push("notes = ?");
        binds.push(c.notes);
    }
    // Track every distinct origin.
    const importedFromExisting = existing.imported_from ?? "";
    if (!importedFromExisting.split(",").includes(importedFrom)) {
        sets.push("imported_from = ?");
        binds.push(importedFromExisting ? `${importedFromExisting},${importedFrom}` : importedFrom);
    }
    // Task #1: union source_url across re-imports. Folk shares (Top-300,
    // FR VCs, etc.) each have their own share URL; re-importing the same
    // firm from a second share must preserve evidence of both shares
    // rather than fill-if-empty (which would silently drop the second
    // URL). Mirrors the imported_from comma-join pattern above; the
    // unified graph still gets one channel/fact per share via dualwrite.
    const newSourceUrl = c.source_url;
    if (typeof newSourceUrl === "string" && newSourceUrl) {
        const existingSourceUrl = existing.source_url ?? "";
        const parts = existingSourceUrl ? existingSourceUrl.split(",").map((s) => s.trim()).filter(Boolean) : [];
        if (!parts.includes(newSourceUrl)) {
            parts.push(newSourceUrl);
            sets.push("source_url = ?");
            binds.push(parts.join(","));
        }
    }
    // Always bump last_modified on every dedupe hit — even when no field
    // deltas applied — so reruns leave a verifiable timestamp trail.
    const action = sets.length ? "updated" : "unchanged";
    sets.push("last_modified = ?");
    binds.push(new Date().toISOString());
    binds.push(existing.id);
    await env.DB.prepare(`UPDATE firms SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
    const persistedWebsite = existing.website ?? c.website ?? null;
    const persistedDomain = existing.domain ?? deriveDomain(persistedWebsite);
    return { firmId: existing.id, action, website: persistedWebsite, domain: persistedDomain };
}
function deriveDomain(website) {
    if (!website)
        return null;
    return extractDomain(website) || null;
}
function slugify(s) {
    return s.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
async function pickUniqueSlug(env, name, domain) {
    const base = slugify(name) || "firm";
    let candidate = base;
    let row = await env.DB.prepare("SELECT 1 AS x FROM firms WHERE slug = ? LIMIT 1").bind(candidate).first();
    if (!row)
        return candidate;
    if (domain) {
        candidate = `${base}-${slugify(domain)}`;
        row = await env.DB.prepare("SELECT 1 AS x FROM firms WHERE slug = ? LIMIT 1").bind(candidate).first();
        if (!row)
            return candidate;
    }
    for (let i = 2; i < 100; i++) {
        const c = `${base}-${i}`;
        row = await env.DB.prepare("SELECT 1 AS x FROM firms WHERE slug = ? LIMIT 1").bind(c).first();
        if (!row)
            return c;
    }
    // Last resort: random suffix.
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}
function parseJsonArray(raw) {
    if (!raw)
        return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.map((x) => String(x)) : [];
    }
    catch {
        return [];
    }
}
function parseJsonObject(raw) {
    if (!raw)
        return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
function uniqStringArray(arr) {
    const seen = new Set();
    const out = [];
    for (const s of arr) {
        const k = String(s).trim();
        if (!k)
            continue;
        const lk = k.toLowerCase();
        if (seen.has(lk))
            continue;
        seen.add(lk);
        out.push(k);
    }
    return out;
}
