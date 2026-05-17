// Task #7: Global search (Cmd-K, fuzzy, instant).
//
// GET /api/search?q=...&type=all|person|org|persona|project|account|view&limit=20
//
// Strategy (fast path, no network):
//   1. Tokenize q on whitespace -> tokens.
//   2. For each searchable bucket, run a single bounded query that requires
//      every token to LIKE-match across (name | subtitle | key | domain).
//   3. Score each row deterministically in JS:
//        +500  exact case-insensitive match on title
//        +400  title starts with full q
//        +250  title contains full q
//        +120  every token starts a word in title
//        + 40  token substring in title
//        + 15  token substring in subtitle
//        + 50  short-title bonus (<= 24 chars)
//        + 25  has internal dashboard href (vs external URL only)
//        + N   quality_score / 4 for entities (max 25)
//   4. Merge, sort desc, slice to limit.
//
// Returns:
//   { q, items: [{id, type, title, subtitle, href, score, kind?}],
//     results: items, source: "d1_fuzzy" }
// `results` is an alias kept for cmdk.js back-compat.

import { Hono } from "hono";
import type { Env } from "../types";

export const search = new Hono<{ Bindings: Env; Variables: { email: string } }>();

type EntityType =
  | "person"
  | "org"
  | "persona"
  | "project"
  | "account"
  | "firm"
  | "company"
  | "lead"
  | "view";

interface Hit {
  id: string;
  type: EntityType;
  title: string;
  subtitle?: string;
  href?: string;
  score: number;
  kind?: string;
}

const TYPE_LABEL: Record<EntityType, string> = {
  person: "Person",
  org: "Organization",
  persona: "Persona",
  project: "Project",
  account: "Customer",
  firm: "Firm",
  company: "Company",
  lead: "Lead",
  view: "Saved view",
};

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[%_]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 6);
}

function scoreRow(qLower: string, tokens: string[], title: string, subtitle: string | null, hasInternalHref: boolean, qualityBoost: number): number {
  const t = (title ?? "").toLowerCase();
  const s = (subtitle ?? "").toLowerCase();
  let score = 0;
  if (t === qLower) score += 500;
  else if (t.startsWith(qLower)) score += 400;
  else if (t.includes(qLower)) score += 250;

  // Word-boundary prefix: every token must start a word in title
  const wordStarts = new Set<string>();
  for (const word of t.split(/[\s\-_/.,()&]+/)) {
    if (word) wordStarts.add(word);
  }
  let allTokenWordStart = tokens.length > 0;
  for (const tok of tokens) {
    let hit = false;
    for (const w of wordStarts) {
      if (w.startsWith(tok)) { hit = true; break; }
    }
    if (!hit) { allTokenWordStart = false; break; }
  }
  if (allTokenWordStart) score += 120;

  for (const tok of tokens) {
    if (t.includes(tok)) score += 40;
    else if (s.includes(tok)) score += 15;
  }

  if (t.length > 0 && t.length <= 24) score += 50;
  if (hasInternalHref) score += 25;
  score += Math.max(0, Math.min(25, Math.round(qualityBoost / 4)));
  return score;
}

function tableExists(env: Env, table: string): Promise<boolean> {
  return env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .bind(table)
    .first<{ name: string }>()
    .then((r) => !!r)
    .catch(() => false);
}

function buildLikeClause(tokens: string[], columns: string[]): { sql: string; binds: string[] } {
  // Every token must hit at least one column.
  const binds: string[] = [];
  const perToken: string[] = [];
  for (const tok of tokens) {
    const like = `%${tok}%`;
    const ors = columns.map((c) => `LOWER(COALESCE(${c}, '')) LIKE ?`).join(" OR ");
    perToken.push(`(${ors})`);
    for (let i = 0; i < columns.length; i++) binds.push(like);
  }
  return { sql: perToken.join(" AND "), binds };
}

async function searchEntities(env: Env, qLower: string, tokens: string[], kindFilter: "person" | "org" | null, perBucket: number): Promise<Hit[]> {
  // Search the materialized rollup first (richer subtitles), fall back to
  // u_entities when entity_summary is absent.
  const useSummary = await tableExists(env, "entity_summary");
  const items: Hit[] = [];

  if (useSummary) {
    const cols = ["s.display_name", "s.primary_employer", "s.city", "s.primary_domain", "s.primary_email", "s.primary_linkedin"];
    const { sql: where, binds } = buildLikeClause(tokens, cols);
    const kindWhere = kindFilter ? "AND s.kind = ?" : "";
    const sql = `SELECT s.entity_id AS id, s.kind, s.display_name, s.primary_role, s.primary_employer, s.city, s.country_iso2, s.primary_domain, s.quality_score
                   FROM entity_summary s
                   JOIN u_entities e ON e.id = s.entity_id
                  WHERE e.status = 'active' AND (${where}) ${kindWhere}
                  LIMIT ?`;
    const params: unknown[] = [...binds];
    if (kindFilter) params.push(kindFilter);
    params.push(perBucket * 3);
    try {
      const r = await env.DB.prepare(sql).bind(...params).all<{
        id: string; kind: string; display_name: string | null; primary_role: string | null;
        primary_employer: string | null; city: string | null; country_iso2: string | null;
        primary_domain: string | null; quality_score: number | null;
      }>();
      for (const row of r.results ?? []) {
        const type: EntityType = row.kind === "person" ? "person" : "org";
        const title = row.display_name || row.primary_domain || row.id;
        const subtitleBits: string[] = [];
        if (row.primary_role) subtitleBits.push(row.primary_role);
        if (row.primary_employer) subtitleBits.push("@ " + row.primary_employer);
        else if (row.primary_domain) subtitleBits.push(row.primary_domain);
        if (row.city) subtitleBits.push(row.city);
        else if (row.country_iso2) subtitleBits.push(row.country_iso2);
        const subtitle = subtitleBits.join(" · ") || null;
        const href = type === "person"
          ? `/dashboard/people/?id=${encodeURIComponent(row.id)}`
          : `/dashboard/firms/?id=${encodeURIComponent(row.id)}`;
        const sc = scoreRow(qLower, tokens, title, subtitle, true, Number(row.quality_score ?? 0));
        items.push({ id: row.id, type, title, subtitle: subtitle ?? undefined, href, score: sc, kind: row.kind });
      }
    } catch { /* fall through to u_entities */ }
  }

  if (items.length < perBucket) {
    const cols = ["display_name", "primary_domain", "primary_email_key", "primary_linkedin_key", "primary_twitter_handle", "primary_github_handle"];
    const { sql: where, binds } = buildLikeClause(tokens, cols);
    const kindWhere = kindFilter ? "AND kind = ?" : "";
    const sql = `SELECT id, kind, display_name, primary_domain, primary_email_key, primary_linkedin_key, quality_score
                   FROM u_entities
                  WHERE status = 'active' AND (${where}) ${kindWhere}
                  LIMIT ?`;
    const params: unknown[] = [...binds];
    if (kindFilter) params.push(kindFilter);
    params.push(perBucket * 2);
    try {
      const seen = new Set(items.map((i) => i.id));
      const r = await env.DB.prepare(sql).bind(...params).all<{
        id: string; kind: string; display_name: string | null; primary_domain: string | null;
        primary_email_key: string | null; primary_linkedin_key: string | null; quality_score: number | null;
      }>();
      for (const row of r.results ?? []) {
        if (seen.has(row.id)) continue;
        const type: EntityType = row.kind === "person" ? "person" : "org";
        const title = row.display_name || row.primary_domain || row.primary_email_key || row.id;
        const subtitle = row.primary_domain || row.primary_email_key || row.primary_linkedin_key || null;
        const href = type === "person"
          ? `/dashboard/people/?id=${encodeURIComponent(row.id)}`
          : `/dashboard/firms/?id=${encodeURIComponent(row.id)}`;
        const sc = scoreRow(qLower, tokens, title, subtitle, true, Number(row.quality_score ?? 0));
        items.push({ id: row.id, type, title, subtitle: subtitle ?? undefined, href, score: sc, kind: row.kind });
      }
    } catch { /* table may not exist on a fresh deploy */ }
  }
  return items;
}

async function searchPersonas(env: Env, qLower: string, tokens: string[], perBucket: number): Promise<Hit[]> {
  if (!(await tableExists(env, "personas"))) return [];
  const cols = ["name", "description"];
  const { sql: where, binds } = buildLikeClause(tokens, cols);
  const sql = `SELECT id, name, description FROM personas WHERE (${where}) LIMIT ?`;
  try {
    const r = await env.DB.prepare(sql).bind(...binds, perBucket).all<{ id: string; name: string; description: string | null }>();
    return (r.results ?? []).map((row) => {
      const subtitle = (row.description ?? "").slice(0, 80) || null;
      const href = `/dashboard/personas/?id=${encodeURIComponent(row.id)}`;
      const sc = scoreRow(qLower, tokens, row.name, subtitle, true, 0);
      return { id: String(row.id), type: "persona" as const, title: row.name, subtitle: subtitle ?? undefined, href, score: sc };
    });
  } catch { return []; }
}

async function searchProjects(env: Env, qLower: string, tokens: string[], perBucket: number): Promise<Hit[]> {
  if (!(await tableExists(env, "projects"))) return [];
  const cols = ["name", "description"];
  const { sql: where, binds } = buildLikeClause(tokens, cols);
  const sql = `SELECT id, name, description FROM projects WHERE (${where}) LIMIT ?`;
  try {
    const r = await env.DB.prepare(sql).bind(...binds, perBucket).all<{ id: string; name: string; description: string | null }>();
    return (r.results ?? []).map((row) => {
      const subtitle = (row.description ?? "").slice(0, 80).replace(/\s+/g, " ") || null;
      const href = `/dashboard/projects/?id=${encodeURIComponent(row.id)}`;
      const sc = scoreRow(qLower, tokens, row.name, subtitle, true, 0);
      return { id: String(row.id), type: "project" as const, title: row.name, subtitle: subtitle ?? undefined, href, score: sc };
    });
  } catch { return []; }
}

async function searchAccounts(env: Env, qLower: string, tokens: string[], perBucket: number): Promise<Hit[]> {
  if (!(await tableExists(env, "accounts"))) return [];
  const cols = ["name", "legal_name", "domain", "description"];
  const { sql: where, binds } = buildLikeClause(tokens, cols);
  const sql = `SELECT id, name, legal_name, domain FROM accounts WHERE (${where}) LIMIT ?`;
  try {
    const r = await env.DB.prepare(sql).bind(...binds, perBucket).all<{ id: string; name: string; legal_name: string | null; domain: string | null }>();
    return (r.results ?? []).map((row) => {
      const subtitle = row.domain || row.legal_name || null;
      const href = `/dashboard/accounts/?id=${encodeURIComponent(row.id)}`;
      const sc = scoreRow(qLower, tokens, row.name, subtitle, true, 0);
      return { id: String(row.id), type: "account" as const, title: row.name, subtitle: subtitle ?? undefined, href, score: sc };
    });
  } catch { return []; }
}

async function searchFirms(env: Env, qLower: string, tokens: string[], perBucket: number): Promise<Hit[]> {
  if (!(await tableExists(env, "firms"))) return [];
  const cols = ["name", "website", "domain"];
  const { sql: where, binds } = buildLikeClause(tokens, cols);
  const sql = `SELECT id, name, website, domain FROM firms WHERE (${where}) LIMIT ?`;
  try {
    const r = await env.DB.prepare(sql).bind(...binds, perBucket).all<{ id: number; name: string; website: string | null; domain: string | null }>();
    return (r.results ?? []).map((row) => {
      const subtitle = row.domain || row.website || null;
      const href = `/dashboard/firms/?legacy_id=${encodeURIComponent(String(row.id))}`;
      const sc = scoreRow(qLower, tokens, row.name, subtitle, true, 0);
      return { id: String(row.id), type: "firm" as const, title: row.name, subtitle: subtitle ?? undefined, href, score: sc };
    });
  } catch { return []; }
}

async function searchCompanies(env: Env, qLower: string, tokens: string[], perBucket: number): Promise<Hit[]> {
  if (!(await tableExists(env, "companies"))) return [];
  const cols = ["name", "website", "domain"];
  const { sql: where, binds } = buildLikeClause(tokens, cols);
  const sql = `SELECT id, name, website, domain FROM companies WHERE (${where}) LIMIT ?`;
  try {
    const r = await env.DB.prepare(sql).bind(...binds, perBucket).all<{ id: number; name: string; website: string | null; domain: string | null }>();
    return (r.results ?? []).map((row) => {
      const subtitle = row.domain || row.website || null;
      const href = `/dashboard/companies/?legacy_id=${encodeURIComponent(String(row.id))}`;
      const sc = scoreRow(qLower, tokens, row.name, subtitle, true, 0);
      return { id: String(row.id), type: "company" as const, title: row.name, subtitle: subtitle ?? undefined, href, score: sc };
    });
  } catch { return []; }
}

async function searchSavedViews(env: Env, qLower: string, tokens: string[], perBucket: number): Promise<Hit[]> {
  if (!(await tableExists(env, "saved_filters"))) return [];
  const cols = ["name"];
  const { sql: where, binds } = buildLikeClause(tokens, cols);
  const sql = `SELECT id, name FROM saved_filters WHERE (${where}) LIMIT ?`;
  try {
    const r = await env.DB.prepare(sql).bind(...binds, perBucket).all<{ id: string; name: string }>();
    return (r.results ?? []).map((row) => {
      const href = `/dashboard/?view=${encodeURIComponent(String(row.id))}`;
      const sc = scoreRow(qLower, tokens, row.name, null, true, 0);
      return { id: String(row.id), type: "view" as const, title: row.name, href, score: sc };
    });
  } catch { return []; }
}

search.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const type = (c.req.query("type") ?? "all").toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  if (!q) return c.json({ q, items: [], results: [], source: "empty" });

  const qLower = q.toLowerCase();
  const tokens = tokenize(q);
  if (tokens.length === 0) return c.json({ q, items: [], results: [], source: "empty" });

  const perBucket = Math.max(8, Math.ceil(limit / 2));
  const wantsAll = type === "all";

  // Run independent bucket queries in parallel.
  const tasks: Array<Promise<Hit[]>> = [];
  if (wantsAll || type === "person") tasks.push(searchEntities(c.env, qLower, tokens, "person", perBucket));
  if (wantsAll || type === "org") tasks.push(searchEntities(c.env, qLower, tokens, "org", perBucket));
  if (wantsAll || type === "persona") tasks.push(searchPersonas(c.env, qLower, tokens, perBucket));
  if (wantsAll || type === "project") tasks.push(searchProjects(c.env, qLower, tokens, perBucket));
  if (wantsAll || type === "account") tasks.push(searchAccounts(c.env, qLower, tokens, perBucket));
  if (wantsAll || type === "firm") tasks.push(searchFirms(c.env, qLower, tokens, perBucket));
  if (wantsAll || type === "company") tasks.push(searchCompanies(c.env, qLower, tokens, perBucket));
  if (wantsAll || type === "view") tasks.push(searchSavedViews(c.env, qLower, tokens, perBucket));

  const groups = await Promise.all(tasks);
  const all: Hit[] = ([] as Hit[]).concat(...groups);

  // De-duplicate by (type,id), keep highest score.
  const byKey = new Map<string, Hit>();
  for (const h of all) {
    const key = `${h.type}:${h.id}`;
    const prev = byKey.get(key);
    if (!prev || h.score > prev.score) byKey.set(key, h);
  }
  const items = Array.from(byKey.values())
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map((h) => ({ ...h, type_label: TYPE_LABEL[h.type] ?? h.type }));

  return c.json({ q, items, results: items, source: "d1_fuzzy" });
});
