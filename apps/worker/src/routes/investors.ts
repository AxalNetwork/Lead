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
import { loadInvestorEntityOverlay, coalesceStr, coalesceNum, coalesceArr } from "../services/investor_entity_merge";
import { materializeInvestorPortfolio } from "../services/investor_portfolio";

export const investors = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const PROFILE_TTL_SEC = 300;
const INVESTOR_KINDS = new Set(["gp", "angel", "operator", "lp", "scout", "principal", "associate"]);
const INVESTORS_SORTABLE: Record<string, string> = {
  name: "l.name",
  investor_kind: "l.investor_kind",
  org: "l.org",
  location: "l.country_iso2",
  investment_count: "l.investment_count",
  unicorn_count: "l.unicorn_count",
  avg_check_usd: "l.avg_check_usd",
};
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

// Build the role-join clause shared by list/aggregate. Persons are
// "investor-like" when their unified entity has at least one of the
// investor roles. Filtering happens on the legacy `leads` row.
const ROLE_JOIN = `
  JOIN entity_legacy_map m ON m.legacy_table = 'leads' AND m.legacy_id = l.id
  JOIN u_entities e        ON e.id = m.entity_id AND e.status = 'active' AND e.kind = 'person'
  JOIN entity_roles er     ON er.entity_id = e.id AND er.role IN ('investor','investor_firm','angel','vc','gp','lp')
`;

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
  // Task #2: owner isolation — single-tenant in dev, but the schema
  // already carries `owner_email` so we filter to the authenticated
  // user (or NULL/global rows) for forward-compatibility with the
  // multi-tenant build.
  const ownerEmail = c.var.email;
  const where: string[] = ["l.merged_into IS NULL", "(l.owner_email = ? OR l.owner_email IS NULL)"];
  const binds: unknown[] = [ownerEmail];
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

  // Click-to-sort allowlist: public sort key -> SQL column. Unknown keys
  // fall back to the default relevance order so ORDER BY is injection-safe.
  const sortCol = INVESTORS_SORTABLE[url.searchParams.get("sort_by") ?? ""];
  const sortDir = url.searchParams.get("sort_dir") === "asc" ? "ASC" : "DESC";
  const orderSql = sortCol
    ? `ORDER BY ${sortCol} ${sortDir} NULLS LAST, l.id DESC`
    : `ORDER BY l.investment_count DESC NULLS LAST, l.unicorn_count DESC NULLS LAST, l.id DESC`;
  const sql = `SELECT DISTINCT l.* FROM leads l ${ROLE_JOIN}
               WHERE ${where.join(" AND ")}
               ${orderSql}
               LIMIT ? OFFSET ?`;
  binds.push(limit + 1, offset);
  const r = await c.env.DB.prepare(sql).bind(...binds).all<InvestorRow>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  return c.json({ items: (hasMore ? rows.slice(0, limit) : rows).map(toListItem), nextOffset: hasMore ? offset + limit : null });
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
  // Task #2: deduplicate the role-join *before* aggregating so a lead
  // with multiple matching roles (e.g. both `investor` and `gp`) is
  // counted once and its SUM contributions aren't multiplied.
  const ownerEmail = c.var.email;
  const baseCte = `
    WITH inv_leads AS (
      SELECT DISTINCT l.id, l.investor_kind, l.country_iso2,
             l.investment_count, l.unicorn_count, l.exit_count
        FROM leads l
        JOIN entity_legacy_map m ON m.legacy_table = 'leads' AND m.legacy_id = l.id
        JOIN u_entities e        ON e.id = m.entity_id AND e.status = 'active' AND e.kind = 'person'
        JOIN entity_roles er     ON er.entity_id = e.id AND er.role IN ('investor','investor_firm','angel','vc','gp','lp')
       WHERE l.merged_into IS NULL
         AND (l.owner_email = ? OR l.owner_email IS NULL)
    )`;
  const total = await c.env.DB.prepare(`${baseCte} SELECT COUNT(*) AS n FROM inv_leads`).bind(ownerEmail).first<{ n: number }>();
  const byKind = await c.env.DB
    .prepare(`${baseCte} SELECT investor_kind AS k, COUNT(*) AS n FROM inv_leads GROUP BY investor_kind ORDER BY n DESC`)
    .bind(ownerEmail).all<{ k: string; n: number }>();
  const byCountry = await c.env.DB
    .prepare(`${baseCte} SELECT country_iso2 AS k, COUNT(*) AS n FROM inv_leads WHERE country_iso2 IS NOT NULL GROUP BY country_iso2 ORDER BY n DESC LIMIT 10`)
    .bind(ownerEmail).all<{ k: string; n: number }>();
  const totals = await c.env.DB
    .prepare(`${baseCte} SELECT COALESCE(SUM(investment_count),0) AS investments, COALESCE(SUM(unicorn_count),0) AS unicorns, COALESCE(SUM(exit_count),0) AS exits FROM inv_leads`)
    .bind(ownerEmail).first<{ investments: number; unicorns: number; exits: number }>();
  return c.json({ total: total?.n ?? 0, by_kind: byKind.results ?? [], by_country: byCountry.results ?? [], totals: totals ?? { investments: 0, unicorns: 0, exits: 0 } });
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

  // Task #31: fill empty scalar fields from the unified entity store (crawled
  // bio/thesis/check-size/focus/socials). Legacy `leads` values always win.
  const overlay = await loadInvestorEntityOverlay(c.env, id);
  const mBio = coalesceStr(row.bio, overlay.bio);
  const mThesis = coalesceStr(row.thesis, overlay.thesis);
  const mCheckMin = coalesceNum(row.check_size_min_usd, overlay.check_size_min_usd);
  const mCheckMax = coalesceNum(row.check_size_max_usd, overlay.check_size_max_usd);
  const mCheckTyp = coalesceNum(row.check_size_typical_usd, overlay.check_size_typical_usd);
  const mStageFocus = coalesceArr(parseJson<string[]>(row.stage_focus_json, []), overlay.stage_focus);
  const mSectorFocus = coalesceArr(parseJson<string[]>(row.sector_focus_slugs_json, []), overlay.sector_focus);
  const mGeoFocus = coalesceArr(parseJson<string[]>(row.geo_focus_json, []), overlay.geo_focus);
  const mLinkedin = coalesceStr(row.linkedin_url, overlay.linkedin_url);
  const mTwitter = coalesceStr(row.twitter_url, overlay.twitter_url);
  const mGithub = coalesceStr(row.github_url, overlay.github_url);
  const mPersonal = coalesceStr(row.personal_url, overlay.personal_url);

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

  const stageBreakdown: Record<string, number> = {};
  const sectorBreakdown: Record<string, number> = {};
  const geoBreakdown: Record<string, number> = {};
  for (const inv of investments) {
    const s = (inv.stage as string | null) ?? "unknown";
    stageBreakdown[s] = (stageBreakdown[s] ?? 0) + 1;
  }
  for (const slug of mSectorFocus) sectorBreakdown[slug] = (sectorBreakdown[slug] ?? 0) + 1;
  for (const g of mGeoFocus) geoBreakdown[g] = (geoBreakdown[g] ?? 0) + 1;

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

  const historyR = await c.env.DB
    .prepare(`SELECT field, old_value, new_value, source, evidence_url, changed_at FROM lead_history WHERE lead_id = ? ORDER BY changed_at DESC LIMIT 50`)
    .bind(id).all<Record<string, unknown>>();

  const boards = parseJson<Array<Record<string, unknown>>>((row as unknown as Record<string, string | null>).board_seats_json ?? null, []);

  const profile = { id: row.id, name: row.name, email: row.email, org: row.org, title: row.title, category: row.category, investor_kind: row.investor_kind, bio: mBio, location: { country_iso2: row.country_iso2, region: row.region, city: row.city }, contact: { email: row.email, linkedin_url: mLinkedin, twitter_url: mTwitter, github_url: mGithub, personal_url: mPersonal, office_hours_url: row.office_hours_url, pitch_form_url: row.pitch_form_url, calendly_url: row.calendly_url }, profiles: { signal_nfx_url: row.signal_nfx_url, crunchbase_url: row.crunchbase_url, wikipedia_url: row.wikipedia_url }, thesis: mThesis, check_size: { min_usd: mCheckMin, max_usd: mCheckMax, typical_usd: mCheckTyp }, sweet_spot_stage: row.sweet_spot_stage, stage_focus: mStageFocus, sector_focus: mSectorFocus, geo_focus: mGeoFocus, fund, current_role_title: row.current_role_title, counters: { investment_count: row.investment_count ?? 0, unicorn_count: row.unicorn_count ?? 0, exit_count: row.exit_count ?? 0, avg_check_usd: row.avg_check_usd, total_deployed_usd: row.total_deployed_usd, board_seats_count: row.board_seats_count ?? 0, media_count: media.length, podcast_count: row.podcast_count ?? 0 }, portfolio: investments, breakdowns: { stage: stageBreakdown, sector: sectorBreakdown, geography: geoBreakdown }, co_investors: coInvestors, boards, media, history: historyR.results ?? [], last_enriched_at: row.last_enriched_at, created_at: row.created_at, updated_at: row.updated_at };

  await c.env.SCRAPE_CACHE.put(cacheKey, JSON.stringify(profile), { expirationTtl: PROFILE_TTL_SEC });
  return c.json(profile);
});

investors.post("/:id/enrich", async (c) => {
  const id = c.req.param("id");
  const lead = await c.env.DB.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return c.json({ error: "not_found" }, 404);
  const force = c.req.query("force") === "1";
  const { enrichLead } = await import("../enrichment/orchestrator");
  const outcome = await enrichLead(c.env, id, { forceRefresh: force });
  // Task #31: rebuild this investor's portfolio from firm_portfolio +
  // companies_json so the profile reflects the freshest crawled data.
  let portfolio: Awaited<ReturnType<typeof materializeInvestorPortfolio>> | null = null;
  try {
    portfolio = await materializeInvestorPortfolio(c.env, { investorLeadId: id });
  } catch (e) {
    console.warn("investor portfolio materialize failed", id, (e as Error).message);
  }
  await c.env.SCRAPE_CACHE.delete(`profile:investor:${id}`);
  return c.json({ status: "ok", outcome, portfolio });
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
      const msg: JobMessage = { jobId, kind: "profile_list", target: id, config: { enrich_kind: "investor", lead_id: id } };
      await c.env.LEAD_QUEUE.send(msg);
      await c.env.SCRAPE_CACHE.delete(`profile:investor:${id}`);
      queued.push(jobId);
    } catch (e) {
      console.warn("bulk investor enrich enqueue failed", id, (e as Error).message);
    }
  }
  return c.json({ queued: queued.length, jobIds: queued });
});

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
