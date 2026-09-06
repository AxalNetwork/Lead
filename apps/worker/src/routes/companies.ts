// Task #24: Company entity API.
//
//   GET  /api/companies                     list + filters
//   GET  /api/companies/aggregate           summary strip
//   GET  /api/companies/:id                 thin row
//   GET  /api/companies/:id/profile         denormalized profile (rounds,
//                                           investors, founders, news, exit)
//   POST /api/companies/:id/enrich          enqueue company_enrich
//   POST /api/companies/enrich/bulk         bulk enrich
//
// Profiles are cached at `profile:company:{id}` for 5 min.

import { Hono } from "hono";
import type { Env, JobMessage } from "../types";
import { loadOrgEntityOverlay, applyOrgOverlay } from "../services/org_entity_merge";

export const companies = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const PROFILE_TTL_SEC = 300;

interface CompanyRow {
  id: number;
  name: string;
  legal_name: string | null;
  slug: string | null;
  domain: string | null;
  website: string | null;
  logo_url: string | null;
  description: string | null;
  status: string;
  founded_year: number | null;
  hq_country_iso2: string | null;
  hq_region: string | null;
  hq_city: string | null;
  industries_json: string | null;
  stage: string | null;
  total_funding_usd: number | null;
  last_round_usd: number | null;
  last_round_at: string | null;
  last_round_stage: string | null;
  valuation_usd: number | null;
  unicorn: number;
  exit_kind: string | null;
  exit_date: string | null;
  exit_value_usd: number | null;
  acquirer_name: string | null;
  ticker: string | null;
  employees: number | null;
  linkedin_url: string | null;
  crunchbase_url: string | null;
  twitter_handle: string | null;
  github_org: string | null;
  pitchbook_url: string | null;
  sec_cik: string | null;
  socials_json: string | null;
  tags_json: string | null;
  source_url: string | null;
  imported_from: string | null;
  meta_json: string | null;
  last_enriched_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return (JSON.parse(raw) ?? fallback) as T; } catch { return fallback; }
}

// -------------------------------------------------------------------- LIST
companies.get("/", async (c) => {
  const url = new URL(c.req.url);
  const limRaw = Number(url.searchParams.get("limit") ?? "50");
  const offRaw = Number(url.searchParams.get("offset") ?? "0");
  if (!Number.isFinite(limRaw) || !Number.isFinite(offRaw) || limRaw < 1 || offRaw < 0) {
    return c.json({ error: "bad_request:limit_offset" }, 400);
  }
  const limit = Math.min(Math.floor(limRaw), 200);
  const offset = Math.floor(offRaw);
  const where: string[] = ["1=1"];
  const binds: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status) { where.push("status = ?"); binds.push(status); }
  const stage = url.searchParams.get("stage");
  if (stage) { where.push("stage = ?"); binds.push(stage); }
  const country = url.searchParams.get("country");
  if (country) { where.push("hq_country_iso2 = ?"); binds.push(country.toUpperCase()); }
  const sector = url.searchParams.get("sector");
  if (sector) { where.push("industries_json LIKE ?"); binds.push(`%"${sector}"%`); }
  const unicorn = url.searchParams.get("unicorn");
  if (unicorn === "1") where.push("unicorn = 1");
  const q = url.searchParams.get("q");
  if (q) { where.push("(lower(name) LIKE ? OR lower(domain) LIKE ?)"); binds.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`); }
  const sql = `SELECT * FROM companies WHERE ${where.join(" AND ")}
               ORDER BY total_funding_usd DESC NULLS LAST, id DESC
               LIMIT ? OFFSET ?`;
  binds.push(limit + 1, offset);
  const r = await c.env.DB.prepare(sql).bind(...binds).all<CompanyRow>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  return c.json({
    items: (hasMore ? rows.slice(0, limit) : rows).map(toListItem),
    nextOffset: hasMore ? offset + limit : null,
  });
});

function toListItem(r: CompanyRow): Record<string, unknown> {
  return {
    id: r.id, name: r.name, slug: r.slug, domain: r.domain, logo_url: r.logo_url,
    status: r.status, stage: r.stage,
    hq_country_iso2: r.hq_country_iso2, hq_city: r.hq_city,
    total_funding_usd: r.total_funding_usd,
    last_round_usd: r.last_round_usd, last_round_stage: r.last_round_stage,
    valuation_usd: r.valuation_usd, unicorn: r.unicorn,
    exit_kind: r.exit_kind, exit_value_usd: r.exit_value_usd,
    industries: parseJson<string[]>(r.industries_json, []),
  };
}

// --------------------------------------------------------------- AGGREGATE
companies.get("/aggregate", async (c) => {
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM companies`).first<{ n: number }>();
  const byStatus = await c.env.DB.prepare(`SELECT status AS k, COUNT(*) AS n FROM companies GROUP BY status`).all<{ k: string; n: number }>();
  const byStage = await c.env.DB.prepare(`SELECT stage AS k, COUNT(*) AS n FROM companies WHERE stage IS NOT NULL GROUP BY stage ORDER BY n DESC`).all<{ k: string; n: number }>();
  const byCountry = await c.env.DB.prepare(`SELECT hq_country_iso2 AS k, COUNT(*) AS n FROM companies WHERE hq_country_iso2 IS NOT NULL GROUP BY hq_country_iso2 ORDER BY n DESC LIMIT 10`).all<{ k: string; n: number }>();
  const totals = await c.env.DB.prepare(`SELECT COALESCE(SUM(total_funding_usd),0) AS total_funding, SUM(unicorn) AS unicorns, COALESCE(SUM(exit_value_usd),0) AS exits FROM companies`).first<{ total_funding: number; unicorns: number; exits: number }>();
  return c.json({
    total: total?.n ?? 0,
    by_status: byStatus.results ?? [],
    by_stage: byStage.results ?? [],
    by_country: byCountry.results ?? [],
    totals: totals ?? { total_funding: 0, unicorns: 0, exits: 0 },
  });
});

// -------------------------------------------------------------------- THIN
companies.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
  const r = await c.env.DB.prepare(`SELECT * FROM companies WHERE id = ?`).bind(id).first<CompanyRow>();
  if (!r) return c.json({ error: "not_found" }, 404);
  // Same gap as firms: extracted description / HQ / founded year / sectors
  // land in `facts`, never in these columns. Fill blanks only.
  const overlay = await loadOrgEntityOverlay(c.env, "companies", id);
  return c.json(applyOrgOverlay(r as unknown as Record<string, unknown>, overlay));
});

// ----------------------------------------------------------------- PROFILE
companies.get("/:id/profile", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
  const cacheKey = `profile:company:${id}`;
  const cached = await c.env.SCRAPE_CACHE.get(cacheKey, "json");
  if (cached) return c.json({ ...(cached as object), _cached: true });

  const row = await c.env.DB.prepare(`SELECT * FROM companies WHERE id = ?`).bind(id).first<CompanyRow>();
  if (!row) return c.json({ error: "not_found" }, 404);

  const founders = (await c.env.DB
    .prepare(`SELECT cf.id, cf.lead_id, cf.name, cf.title, cf.linkedin_url, cf.twitter_url, cf.bio, cf.is_active, cf.joined_year, cf.left_year
                FROM company_founders cf WHERE cf.company_id = ? ORDER BY cf.is_active DESC, cf.id ASC`)
    .bind(id).all()).results ?? [];

  const rounds = (await c.env.DB
    .prepare(`SELECT cr.*
                FROM company_rounds cr WHERE cr.company_id = ?
               ORDER BY cr.raised_at DESC NULLS LAST, cr.id DESC`)
    .bind(id).all()).results ?? [];

  // Investors = participants on every round + direct investor_investments rows.
  const investorsR = await c.env.DB.prepare(
    `SELECT ii.*, l.name AS investor_name, l.investor_kind, f.name AS firm_name, f.domain AS firm_domain
       FROM investor_investments ii
  LEFT JOIN leads l ON l.id = ii.investor_lead_id
  LEFT JOIN firms f ON f.id = ii.firm_id
      WHERE ii.company_id = ?
      ORDER BY ii.invested_at DESC NULLS LAST, ii.id DESC`,
  ).bind(id).all<Record<string, unknown>>();
  const investors = investorsR.results ?? [];

  const news = (await c.env.DB
    .prepare(`SELECT id, url, title, source, published_at, summary FROM company_news WHERE company_id = ? ORDER BY published_at DESC NULLS LAST LIMIT 50`)
    .bind(id).all()).results ?? [];

  const history = (await c.env.DB
    .prepare(`SELECT field, old_value, new_value, source, evidence_url, changed_at FROM company_history WHERE company_id = ? ORDER BY changed_at DESC LIMIT 50`)
    .bind(id).all()).results ?? [];

  const profile = {
    id: row.id,
    name: row.name, legal_name: row.legal_name, slug: row.slug,
    domain: row.domain, website: row.website, logo_url: row.logo_url,
    description: row.description,
    status: row.status, founded_year: row.founded_year,
    location: { country_iso2: row.hq_country_iso2, region: row.hq_region, city: row.hq_city },
    industries: parseJson<string[]>(row.industries_json, []),
    stage: row.stage,
    funding: {
      total_funding_usd: row.total_funding_usd,
      last_round_usd: row.last_round_usd,
      last_round_at: row.last_round_at,
      last_round_stage: row.last_round_stage,
      valuation_usd: row.valuation_usd,
      unicorn: row.unicorn === 1,
    },
    exit: row.exit_kind ? {
      kind: row.exit_kind, date: row.exit_date,
      value_usd: row.exit_value_usd, acquirer_name: row.acquirer_name, ticker: row.ticker,
    } : null,
    employees: row.employees,
    profiles: {
      linkedin_url: row.linkedin_url, crunchbase_url: row.crunchbase_url,
      twitter_handle: row.twitter_handle, github_org: row.github_org,
      pitchbook_url: row.pitchbook_url, sec_cik: row.sec_cik,
    },
    socials: parseJson<Record<string, string>>(row.socials_json, {}),
    tags: parseJson<string[]>(row.tags_json, []),
    founders, rounds, investors, news, history,
    last_enriched_at: row.last_enriched_at,
    created_at: row.created_at, updated_at: row.updated_at,
  };

  await c.env.SCRAPE_CACHE.put(cacheKey, JSON.stringify(profile), { expirationTtl: PROFILE_TTL_SEC });
  return c.json(profile);
});

// ------------------------------------------------------------------ ENRICH
companies.post("/:id/enrich", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
  const row = await c.env.DB.prepare("SELECT id FROM companies WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, 'company_enrich', 'queued', 'profile_list', ?, ?, ?, ?)`,
  ).bind(jobId, `company_enrich:${id}`, String(id), JSON.stringify({ enrich_kind: "company", company_id: id }), now, now).run();
  const msg: JobMessage = { jobId, kind: "profile_list", target: String(id), config: { enrich_kind: "company", company_id: id } };
  await c.env.LEAD_QUEUE.send(msg);
  await c.env.SCRAPE_CACHE.delete(`profile:company:${id}`);
  return c.json({ jobId, status: "queued" });
});

companies.post("/enrich/bulk", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: number[] } | null;
  const ids = (body?.ids ?? []).slice(0, 200).filter((x) => Number.isFinite(x));
  if (!ids.length) return c.json({ error: "empty_ids" }, 400);
  const queued: string[] = [];
  for (const id of ids) {
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await c.env.DB.prepare(
        `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
         VALUES (?, ?, 'company_enrich', 'queued', 'profile_list', ?, ?, ?, ?)`,
      ).bind(jobId, `company_enrich:${id}`, String(id), JSON.stringify({ enrich_kind: "company", company_id: id }), now, now).run();
      await c.env.LEAD_QUEUE.send({ jobId, kind: "profile_list", target: String(id), config: { enrich_kind: "company", company_id: id } });
      await c.env.SCRAPE_CACHE.delete(`profile:company:${id}`);
      queued.push(jobId);
    } catch (e) {
      console.warn("bulk company enrich enqueue failed", id, (e as Error).message);
    }
  }
  return c.json({ queued: queued.length, jobIds: queued });
});
