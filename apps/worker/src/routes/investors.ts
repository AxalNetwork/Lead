// Task #24: Investor profile API.
//
// Endpoints (all behind accessGuard, mounted in src/index.ts):
//
//   GET  /api/investors                     list + filters (browse page)
//   GET  /api/investors/aggregate           summary strip aggregates
//   GET  /api/investors/:id/profile         denormalized 12-tab payload
//   POST /api/investors/:id/enrich          enqueue enrichment job
//   POST /api/investors/enrich/bulk         bulk enrich
//   GET  /api/investors/:id/path?to=:to     "Path to this investor" via Task #21
//
// The `:id` parameter is a `leads.id` UUID. Investors are leads with
// investor_kind set (gp|angel|operator|lp|scout|principal|associate).
// Profile responses are cached in KV at `profile:investor:{id}` for 5 min;
// busted on lead_history writes (see leads.repo.ts updateLead) — for now
// we rely on the TTL and the explicit /enrich invalidation.

import { Hono } from "hono";
import type { Env, JobMessage } from "../types";

export const investors = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const PROFILE_TTL_SEC = 300;
const INVESTOR_KINDS = new Set(["gp", "angel", "operator", "lp", "scout", "principal", "associate"]);

interface InvestorRow {
  id: string;
  name: string | null;
  email: string | null;
  org: string | null;
  title: string | null;
  category: string | null;
  investor_kind: string | null;
  thesis: string | null;
  check_size_min_usd: number | null;
  check_size_max_usd: number | null;
  check_size_typical_usd: number | null;
  sweet_spot_stage: string | null;
  stage_focus_json: string | null;
  sector_focus_slugs_json: string | null;
  geo_focus_json: string | null;
  country_iso2: string | null;
  region: string | null;
  city: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  github_url: string | null;
  personal_url: string | null;
  signal_nfx_url: string | null;
  crunchbase_url: string | null;
  wikipedia_url: string | null;
  office_hours_url: string | null;
  pitch_form_url: string | null;
  calendly_url: string | null;
  bio: string | null;
  current_fund_id: number | null;
  current_role_title: string | null;
  investment_count: number | null;
  unicorn_count: number | null;
  exit_count: number | null;
  avg_check_usd: number | null;
  total_deployed_usd: number | null;
  board_seats_count: number | null;
  media_count: number | null;
  podcast_count: number | null;
  last_enriched_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

// -------------------------------------------------------------------- LIST
investors.get("/", async (c) => {
  const url = new URL(c.req.url);
  const limRaw = Number(url.searchParams.get("limit") ?? "50");
  const offRaw = Number(url.searchParams.get("offset") ?? "0");
  if (!Number.isFinite(limRaw) || !Number.isFinite(offRaw) || limRaw < 1 || offRaw < 0) {
    return c.json({ error: "bad_request:limit_offset" }, 400);
  }
  const limit = Math.min(Math.floor(limRaw), 200);
  const offset = Math.floor(offRaw);
  const where: string[] = ["l.merged_into IS NULL", "l.investor_kind IS NOT NULL"];
  const binds: unknown[] = [];
  const kind = url.searchParams.get("kind");
  if (kind && INVESTOR_KINDS.has(kind)) { where.push("l.investor_kind = ?"); binds.push(kind); }
  const stage = url.searchParams.get("stage");
  if (stage) { where.push("(l.stage_focus_json LIKE ? OR l.sweet_spot_stage = ?)"); binds.push(`%"${stage}"%`, stage); }
  const sector = url.searchParams.get("sector");
  if (sector) { where.push("l.sector_focus_slugs_json LIKE ?"); binds.push(`%"${sector}"%`); }
  const country = url.searchParams.get("country");
  if (country) { where.push("l.country_iso2 = ?"); binds.push(country.toUpperCase()); }
  const minCheck = Number(url.searchParams.get("min_check_usd") ?? "0");
  if (minCheck > 0) { where.push("(l.check_size_typical_usd >= ? OR l.check_size_max_usd >= ?)"); binds.push(minCheck, minCheck); }
  const q = url.searchParams.get("q");
  if (q) { where.push("(lower(l.name) LIKE ? OR lower(l.org) LIKE ?)"); binds.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`); }
  const sql = `SELECT l.* FROM leads l WHERE ${where.join(" AND ")}
               ORDER BY l.investment_count DESC NULLS LAST, l.unicorn_count DESC NULLS LAST, l.id DESC
               LIMIT ? OFFSET ?`;
  binds.push(limit + 1, offset);
  const r = await c.env.DB.prepare(sql).bind(...binds).all<InvestorRow>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  return c.json({
    items: (hasMore ? rows.slice(0, limit) : rows).map(toListItem),
    nextOffset: hasMore ? offset + limit : null,
  });
});

function toListItem(r: InvestorRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name, org: r.org, title: r.title,
    investor_kind: r.investor_kind,
    country_iso2: r.country_iso2, city: r.city,
    investment_count: r.investment_count ?? 0,
    unicorn_count: r.unicorn_count ?? 0,
    avg_check_usd: r.avg_check_usd,
    sweet_spot_stage: r.sweet_spot_stage,
    sector_focus: parseJson<string[]>(r.sector_focus_slugs_json, []),
    geo_focus: parseJson<string[]>(r.geo_focus_json, []),
    linkedin_url: r.linkedin_url,
    last_enriched_at: r.last_enriched_at,
  };
}

// --------------------------------------------------------------- AGGREGATE
investors.get("/aggregate", async (c) => {
  const where = "l.merged_into IS NULL AND l.investor_kind IS NOT NULL";
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where}`).first<{ n: number }>();
  const byKind = await c.env.DB
    .prepare(`SELECT l.investor_kind AS k, COUNT(*) AS n FROM leads l WHERE ${where} GROUP BY l.investor_kind ORDER BY n DESC`)
    .all<{ k: string; n: number }>();
  const byCountry = await c.env.DB
    .prepare(`SELECT l.country_iso2 AS k, COUNT(*) AS n FROM leads l WHERE ${where} AND l.country_iso2 IS NOT NULL GROUP BY l.country_iso2 ORDER BY n DESC LIMIT 10`)
    .all<{ k: string; n: number }>();
  const totals = await c.env.DB
    .prepare(`SELECT COALESCE(SUM(l.investment_count),0) AS investments, COALESCE(SUM(l.unicorn_count),0) AS unicorns, COALESCE(SUM(l.exit_count),0) AS exits FROM leads l WHERE ${where}`)
    .first<{ investments: number; unicorns: number; exits: number }>();
  return c.json({
    total: total?.n ?? 0,
    by_kind: byKind.results ?? [],
    by_country: byCountry.results ?? [],
    totals: totals ?? { investments: 0, unicorns: 0, exits: 0 },
  });
});

// ----------------------------------------------------------------- PROFILE
investors.get("/:id/profile", async (c) => {
  const id = c.req.param("id");
  const cacheKey = `profile:investor:${id}`;
  const cached = await c.env.SCRAPE_CACHE.get(cacheKey, "json");
  if (cached) return c.json({ ...(cached as object), _cached: true });

  const row = await c.env.DB.prepare(
    `SELECT * FROM leads WHERE id = ? AND merged_into IS NULL`,
  ).bind(id).first<InvestorRow>();
  if (!row) return c.json({ error: "not_found" }, 404);

  // Fund (current employer) — only if linked.
  let fund: Record<string, unknown> | null = null;
  if (row.current_fund_id != null) {
    fund = await c.env.DB
      .prepare(`SELECT id, name, domain, website, kind, hq_country_iso2, hq_city, aum_usd, current_fund_size_usd, logo_url FROM firms WHERE id = ?`)
      .bind(row.current_fund_id).first();
  }

  // Investments → join companies.
  const invR = await c.env.DB.prepare(
    `SELECT ii.*, c.name AS company_name, c.domain AS company_domain, c.logo_url AS company_logo,
            c.stage AS company_stage, c.unicorn AS company_unicorn, c.exit_kind AS company_exit_kind,
            c.exit_value_usd AS company_exit_value
       FROM investor_investments ii
  LEFT JOIN companies c ON c.id = ii.company_id
      WHERE ii.investor_lead_id = ?
      ORDER BY ii.invested_at DESC NULLS LAST, ii.id DESC
      LIMIT 200`,
  ).bind(id).all<Record<string, unknown>>();
  const investments = invR.results ?? [];

  // Stage / sector / geography breakdowns from investments.
  const stageBreakdown: Record<string, number> = {};
  const sectorBreakdown: Record<string, number> = {};
  const geoBreakdown: Record<string, number> = {};
  for (const inv of investments) {
    const s = (inv.stage as string | null) ?? "unknown";
    stageBreakdown[s] = (stageBreakdown[s] ?? 0) + 1;
  }
  for (const slug of parseJson<string[]>(row.sector_focus_slugs_json, [])) {
    sectorBreakdown[slug] = (sectorBreakdown[slug] ?? 0) + 1;
  }
  for (const g of parseJson<string[]>(row.geo_focus_json, [])) {
    geoBreakdown[g] = (geoBreakdown[g] ?? 0) + 1;
  }

  // Co-investors: every other investor that touched the same companies.
  const companyIds = investments.map((i) => i.company_id).filter(Boolean) as number[];
  let coInvestors: Array<{ investor_lead_id: string; name: string; shared: number }> = [];
  if (companyIds.length) {
    const placeholders = companyIds.map(() => "?").join(",");
    const r2 = await c.env.DB.prepare(
      `SELECT ii.investor_lead_id, l.name, COUNT(*) AS shared
         FROM investor_investments ii
    LEFT JOIN leads l ON l.id = ii.investor_lead_id
        WHERE ii.company_id IN (${placeholders})
          AND ii.investor_lead_id IS NOT NULL
          AND ii.investor_lead_id != ?
        GROUP BY ii.investor_lead_id
        ORDER BY shared DESC, ii.investor_lead_id
        LIMIT 50`,
    ).bind(...companyIds, id).all<{ investor_lead_id: string; name: string; shared: number }>();
    coInvestors = r2.results ?? [];
  }

  // Recent media — pulled from company_news rows for portfolio companies
  // (a cheap stand-in for a dedicated investor_media table; expand later).
  let media: Array<Record<string, unknown>> = [];
  if (companyIds.length) {
    const placeholders = companyIds.map(() => "?").join(",");
    const r3 = await c.env.DB.prepare(
      `SELECT cn.url, cn.title, cn.source, cn.published_at, c.name AS company_name
         FROM company_news cn JOIN companies c ON c.id = cn.company_id
        WHERE cn.company_id IN (${placeholders})
        ORDER BY cn.published_at DESC NULLS LAST LIMIT 30`,
    ).bind(...companyIds).all<Record<string, unknown>>();
    media = r3.results ?? [];
  }

  // History — last 50 lead_history changes for this lead.
  const historyR = await c.env.DB
    .prepare(`SELECT field, old_value, new_value, source, evidence_url, changed_at FROM lead_history WHERE lead_id = ? ORDER BY changed_at DESC LIMIT 50`)
    .bind(id).all<Record<string, unknown>>();

  // Boards & advisory — pulled from leads.board_seats_json.
  const boards = parseJson<Array<Record<string, unknown>>>((row as unknown as Record<string, string | null>).board_seats_json ?? null, []);

  const profile = {
    id: row.id,
    name: row.name, email: row.email, org: row.org, title: row.title,
    category: row.category,
    investor_kind: row.investor_kind,
    bio: row.bio,
    location: { country_iso2: row.country_iso2, region: row.region, city: row.city },
    contact: {
      email: row.email,
      linkedin_url: row.linkedin_url,
      twitter_url: row.twitter_url,
      github_url: row.github_url,
      personal_url: row.personal_url,
      office_hours_url: row.office_hours_url,
      pitch_form_url: row.pitch_form_url,
      calendly_url: row.calendly_url,
    },
    profiles: {
      signal_nfx_url: row.signal_nfx_url,
      crunchbase_url: row.crunchbase_url,
      wikipedia_url: row.wikipedia_url,
    },
    thesis: row.thesis,
    check_size: {
      min_usd: row.check_size_min_usd,
      max_usd: row.check_size_max_usd,
      typical_usd: row.check_size_typical_usd,
    },
    sweet_spot_stage: row.sweet_spot_stage,
    stage_focus: parseJson<string[]>(row.stage_focus_json, []),
    sector_focus: parseJson<string[]>(row.sector_focus_slugs_json, []),
    geo_focus: parseJson<string[]>(row.geo_focus_json, []),
    fund,
    current_role_title: row.current_role_title,
    counters: {
      investment_count: row.investment_count ?? 0,
      unicorn_count: row.unicorn_count ?? 0,
      exit_count: row.exit_count ?? 0,
      avg_check_usd: row.avg_check_usd,
      total_deployed_usd: row.total_deployed_usd,
      board_seats_count: row.board_seats_count ?? 0,
      media_count: media.length,
      podcast_count: row.podcast_count ?? 0,
    },
    portfolio: investments,
    breakdowns: { stage: stageBreakdown, sector: sectorBreakdown, geography: geoBreakdown },
    co_investors: coInvestors,
    boards,
    media,
    history: historyR.results ?? [],
    last_enriched_at: row.last_enriched_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  await c.env.SCRAPE_CACHE.put(cacheKey, JSON.stringify(profile), { expirationTtl: PROFILE_TTL_SEC });
  return c.json(profile);
});

// ------------------------------------------------------------------ ENRICH
investors.post("/:id/enrich", async (c) => {
  const id = c.req.param("id");
  const lead = await c.env.DB.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return c.json({ error: "not_found" }, 404);
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, 'investor_enrich', 'queued', 'profile_list', ?, ?, ?, ?)`,
  ).bind(jobId, `investor_enrich:${id}`, id, JSON.stringify({ enrich_kind: "investor", lead_id: id }), now, now).run();
  const msg: JobMessage = { jobId, kind: "profile_list", target: id, config: { enrich_kind: "investor", lead_id: id } };
  await c.env.LEAD_QUEUE.send(msg);
  // Bust the profile cache so callers re-fetch fresh data after enrichment.
  await c.env.SCRAPE_CACHE.delete(`profile:investor:${id}`);
  return c.json({ jobId, status: "queued" });
});

investors.post("/enrich/bulk", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: string[] } | null;
  const ids = (body?.ids ?? []).slice(0, 200);
  if (!ids.length) return c.json({ error: "empty_ids" }, 400);
  const queued: string[] = [];
  for (const id of ids) {
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await c.env.DB.prepare(
        `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
         VALUES (?, ?, 'investor_enrich', 'queued', 'profile_list', ?, ?, ?, ?)`,
      ).bind(jobId, `investor_enrich:${id}`, id, JSON.stringify({ enrich_kind: "investor", lead_id: id }), now, now).run();
      await c.env.LEAD_QUEUE.send({ jobId, kind: "profile_list", target: id, config: { enrich_kind: "investor", lead_id: id } });
      await c.env.SCRAPE_CACHE.delete(`profile:investor:${id}`);
      queued.push(jobId);
    } catch (e) {
      console.warn("bulk investor enrich enqueue failed", id, (e as Error).message);
    }
  }
  return c.json({ queued: queued.length, jobIds: queued });
});

// -------------------------------------------------- "Path to this investor"
// The graph lives in the `entities` + `relationships` tables (Task #21), keyed
// by integer entity IDs — not lead UUIDs. We resolve both leads to their
// entity rows and then 307-redirect to the canonical /api/relationships/path
// endpoint, which performs a bidirectional BFS over the full graph (not just
// edges incident on the two endpoints).
investors.get("/:id/path", async (c) => {
  const id = c.req.param("id");
  const to = c.req.query("to");
  if (!to) return c.json({ error: "missing_to" }, 400);
  const ents = await c.env.DB
    .prepare("SELECT ref_id, id FROM entities WHERE ref_table = 'leads' AND ref_id IN (?, ?)")
    .bind(id, to)
    .all<{ ref_id: string; id: number }>();
  const map = new Map((ents.results ?? []).map((r) => [r.ref_id, r.id]));
  const srcEnt = map.get(id);
  const dstEnt = map.get(to);
  if (!srcEnt || !dstEnt) return c.json({ path: null, reason: "no_entity_for_lead" });
  const params = new URLSearchParams({ src: String(srcEnt), dst: String(dstEnt) });
  const maxHops = c.req.query("max_hops");
  if (maxHops) params.set("max_hops", maxHops);
  const kinds = c.req.query("kinds");
  if (kinds) params.set("kinds", kinds);
  const url = new URL(c.req.url);
  return c.redirect(`${url.origin}/api/relationships/path?${params.toString()}`, 307);
});
