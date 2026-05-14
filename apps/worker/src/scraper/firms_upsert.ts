import type { Env } from "../types";
import { extractDomain } from "./normalize";
import type { FirmCandidate } from "./parsers/firmlists/types";

/**
 * Firm upsert helper used by every firm-list importer.
 *
 * Dedupe key: (lower(name), domain). `domain` is taken from the candidate,
 * or derived from `website`. Both names and domains are normalized
 * before comparison.
 *
 * Behavior:
 * - On hit: merge non-null fields from the candidate into the existing row
 *   (existing non-null values win for scalar fields; JSON-array fields get
 *   set-union'd; `last_modified` is bumped to now).
 * - On miss: insert a new row with a slug derived from the name (with a
 *   domain suffix if the slug already exists).
 *
 * Returns the firm id and the action taken.
 */
export interface UpsertResult {
  firmId: number;
  action: "created" | "updated" | "unchanged";
  /** Canonical website persisted on the firm row after upsert (may be null). */
  website: string | null;
  /** Canonical lowercase domain persisted on the firm row (may be null). */
  domain: string | null;
}

const SCALAR_FIELDS = [
  "legal_name", "kind", "website", "logo_url",
  "hq_country_iso2", "hq_region", "hq_city",
  "thesis", "check_size_min_usd", "check_size_max_usd", "check_size_typical_usd",
  "aum_usd", "fund_count", "current_fund_name", "current_fund_size_usd",
  "lead_or_co", "portfolio_count", "founded_year", "team_size",
  "linkedin_url", "crunchbase_url", "twitter_handle",
  "signal_nfx_url", "openvc_url", "pitchbook_url",
  "contact_email", "submission_url", "source_url",
] as const;

const ARRAY_FIELDS: Array<{ key: keyof FirmCandidate; column: string }> = [
  { key: "geo_focus", column: "geo_focus_json" },
  { key: "stages", column: "stages_json" },
  { key: "sectors", column: "sectors_json" },
  { key: "notable_investments", column: "notable_investments_json" },
];

interface FirmRow {
  id: number;
  name: string;
  domain: string | null;
  [k: string]: unknown;
}

export async function upsertFirm(
  env: Env,
  candidate: FirmCandidate,
  importedFrom: string,
): Promise<UpsertResult> {
  const name = candidate.name?.trim();
  if (!name) throw new Error("upsertFirm: candidate.name required");
  const rawDomain = candidate.domain ?? deriveDomain(candidate.website);
  const domain = rawDomain ? rawDomain.toLowerCase().trim() : null;
  if (domain) candidate.domain = domain;

  // Quality gate: require name + (domain OR website). Without either,
  // dedupe is impossible and reruns would create endless duplicates.
  if (!domain && !candidate.website) {
    throw new Error("upsertFirm: candidate must have domain or website");
  }
  const lname = name.toLowerCase();

  // Dedupe lookup. Match on the effective domain (stored.domain coalesced
  // with the parsed hostname of stored.website) so a rerun that supplies
  // a domain still merges with a row that originally only had a website.
  const candidates = await env.DB.prepare(
    "SELECT * FROM firms WHERE lower(name) = ? LIMIT 50",
  ).bind(lname).all<FirmRow>();
  const rows = candidates.results ?? [];
  let existing: FirmRow | null = null;
  for (const r of rows) {
    const storedDomain = (r.domain as string | null) ?? deriveDomain((r.website as string | null) ?? undefined);
    if (domain && storedDomain && storedDomain.toLowerCase() === domain) { existing = r; break; }
    if (!domain && !storedDomain) { existing = r; break; }
  }

  if (existing) return mergeInto(env, existing, candidate, importedFrom);
  return insertNew(env, candidate, domain, importedFrom);
}

async function insertNew(
  env: Env,
  c: FirmCandidate,
  domain: string | null,
  importedFrom: string,
): Promise<UpsertResult> {
  const slug = await pickUniqueSlug(env, c.name, domain);
  const cols: string[] = ["name", "slug", "domain", "imported_from", "last_modified"];
  const vals: unknown[] = [c.name.trim(), slug, domain, importedFrom, new Date().toISOString()];
  for (const f of SCALAR_FIELDS) {
    const v = (c as unknown as Record<string, unknown>)[f];
    if (v != null && v !== "") {
      cols.push(f);
      vals.push(v);
    }
  }
  for (const { key, column } of ARRAY_FIELDS) {
    const v = c[key] as string[] | null | undefined;
    if (v && v.length) {
      cols.push(column);
      vals.push(JSON.stringify(uniqStringArray(v)));
    }
  }
  if (c.socials) { cols.push("socials_json"); vals.push(JSON.stringify(c.socials)); }
  if (c.notes)   { cols.push("notes");        vals.push(c.notes); }

  const placeholders = cols.map(() => "?").join(",");
  const r = await env.DB.prepare(
    `INSERT INTO firms (${cols.join(",")}) VALUES (${placeholders})`,
  ).bind(...vals).run();
  const firmId = Number(r.meta.last_row_id);
  return { firmId, action: "created", website: c.website ?? null, domain };
}

async function mergeInto(
  env: Env,
  existing: FirmRow,
  c: FirmCandidate,
  importedFrom: string,
): Promise<UpsertResult> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  // Scalar: only fill missing values; existing non-null values win.
  for (const f of SCALAR_FIELDS) {
    const newVal = (c as unknown as Record<string, unknown>)[f];
    if (newVal == null || newVal === "") continue;
    if (existing[f] == null || existing[f] === "") {
      sets.push(`${f} = ?`);
      binds.push(newVal);
    }
  }
  // Array fields: set-union of existing JSON array + new entries.
  for (const { key, column } of ARRAY_FIELDS) {
    const incoming = c[key] as string[] | null | undefined;
    if (!incoming || !incoming.length) continue;
    const existingArr = parseJsonArray(existing[column] as string | null);
    const merged = uniqStringArray([...existingArr, ...incoming]);
    if (merged.length !== existingArr.length) {
      sets.push(`${column} = ?`);
      binds.push(JSON.stringify(merged));
    }
  }
  if (c.socials) {
    const existingSocials = parseJsonObject(existing.socials_json as string | null);
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
  const importedFromExisting = (existing.imported_from as string | null) ?? "";
  if (!importedFromExisting.split(",").includes(importedFrom)) {
    sets.push("imported_from = ?");
    binds.push(importedFromExisting ? `${importedFromExisting},${importedFrom}` : importedFrom);
  }
  // Always bump last_modified on every dedupe hit — even when no field
  // deltas applied — so reruns leave a verifiable timestamp trail.
  const action: "updated" | "unchanged" = sets.length ? "updated" : "unchanged";
  sets.push("last_modified = ?");
  binds.push(new Date().toISOString());
  binds.push(existing.id);
  await env.DB.prepare(`UPDATE firms SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  const persistedWebsite = (existing.website as string | null) ?? c.website ?? null;
  const persistedDomain = (existing.domain as string | null) ?? deriveDomain(persistedWebsite);
  return { firmId: existing.id, action, website: persistedWebsite, domain: persistedDomain };
}

function deriveDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  return extractDomain(website) || null;
}

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function pickUniqueSlug(env: Env, name: string, domain: string | null): Promise<string> {
  const base = slugify(name) || "firm";
  let candidate = base;
  let row = await env.DB.prepare("SELECT 1 AS x FROM firms WHERE slug = ? LIMIT 1").bind(candidate).first();
  if (!row) return candidate;
  if (domain) {
    candidate = `${base}-${slugify(domain)}`;
    row = await env.DB.prepare("SELECT 1 AS x FROM firms WHERE slug = ? LIMIT 1").bind(candidate).first();
    if (!row) return candidate;
  }
  for (let i = 2; i < 100; i++) {
    const c = `${base}-${i}`;
    row = await env.DB.prepare("SELECT 1 AS x FROM firms WHERE slug = ? LIMIT 1").bind(c).first();
    if (!row) return c;
  }
  // Last resort: random suffix.
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch { return []; }
}

function parseJsonObject(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch { return {}; }
}

function uniqStringArray(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = String(s).trim();
    if (!k) continue;
    const lk = k.toLowerCase();
    if (seen.has(lk)) continue;
    seen.add(lk);
    out.push(k);
  }
  return out;
}
