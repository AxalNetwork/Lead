import { Hono } from "hono";
import type { Env } from "../types";
import { backfillFirmsFromLeads } from "../scripts/backfill-firms-from-leads";
import { parseFirmFilter, buildFirmWhere } from "./_firms_filter";

export const firms = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const FIRM_FIELDS = [
  "name", "legal_name", "slug", "kind", "website", "domain", "logo_url",
  "hq_country_iso2", "hq_region", "hq_city",
  "geo_focus_json", "stages_json", "sectors_json", "thesis",
  "check_size_min_usd", "check_size_max_usd", "check_size_typical_usd",
  "aum_usd", "fund_count", "current_fund_name", "current_fund_size_usd",
  "lead_or_co", "portfolio_count", "unicorns_count", "exits_count",
  "notable_investments_json", "founded_year", "team_size",
  "linkedin_url", "crunchbase_url", "twitter_handle",
  "signal_nfx_url", "openvc_url", "pitchbook_url", "socials_json",
  "contact_email", "submission_url", "notes", "source_url",
  "imported_from", "status", "quality_score", "last_enriched_at",
] as const;
const FIRM_FIELD_SET = new Set<string>(FIRM_FIELDS);

function jsonish(v: unknown): unknown {
  if (Array.isArray(v) || (typeof v === "object" && v !== null)) return JSON.stringify(v);
  return v;
}
function normalize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function intOrNull(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// --------- LIST ---------
// Uses the shared filter parser/builder so /aggregate and analytics drilldowns
// stay consistent with the search page. Cursor pagination is layered on top.
// Allowed sort columns. Whitelist prevents SQL injection — anything not in
// this set falls through to the default `id DESC`.
const SORTABLE: Record<string, string> = {
  name: "name", kind: "kind", hq_country_iso2: "hq_country_iso2",
  hq_city: "hq_city", check_size_typical_usd: "check_size_typical_usd",
  aum_usd: "aum_usd", portfolio_count: "portfolio_count",
  unicorns_count: "unicorns_count", exits_count: "exits_count",
  last_modified: "last_modified", created_at: "created_at",
  founded_year: "founded_year", quality_score: "quality_score",
};

firms.get("/", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  const cursor = intOrNull(url.searchParams.get("cursor") ?? undefined);
  const sortByRaw = url.searchParams.get("sort_by") ?? "";
  const sortDirRaw = (url.searchParams.get("sort_dir") ?? "desc").toLowerCase();
  const sortCol = SORTABLE[sortByRaw] ?? "id";
  const sortDir = sortDirRaw === "asc" ? "ASC" : "DESC";
  const filter = parseFirmFilter(url.searchParams);
  const { sql: whereCore, binds } = buildFirmWhere(filter);
  let whereSql = whereCore;
  // Cursor pagination is only valid alongside the default id-DESC order. When
  // the client sorts by a different column, we drop the cursor (UI uses
  // offset-style pagination via load-more re-issuing the query).
  if (cursor != null && sortCol === "id" && sortDir === "DESC") {
    whereSql = whereCore ? `${whereCore} AND id < ?` : "WHERE id < ?";
    binds.push(cursor);
  }
  const orderBy = sortCol === "id"
    ? `id ${sortDir}`
    : `${sortCol} ${sortDir} NULLS LAST, id DESC`;
  const r = await c.env.DB
    .prepare(`SELECT * FROM v_firms ${whereSql} ORDER BY ${orderBy} LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  // Cursor is only stable under default id-DESC ordering. For any custom sort
  // we omit nextCursor so the client knows not to attempt a load-more (which
  // would otherwise duplicate rows by re-issuing the same query).
  const cursorStable = sortCol === "id" && sortDir === "DESC";
  const nextCursor = hasMore && cursorStable ? (items[items.length - 1].id as number) : null;
  return c.json({ items, nextCursor });
});

// --------- AGGREGATE (summary strip) ---------
// Parameterized SQL — ignores cursor/limit. Median uses ROW_NUMBER over a
// non-null window. Top-3 sectors come from the same JSON-substring trick the
// list endpoint uses.
firms.get("/aggregate", async (c) => {
  const url = new URL(c.req.url);
  const filter = parseFirmFilter(url.searchParams);
  const { sql: whereSql, binds } = buildFirmWhere(filter);
  const totalRow = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(aum_usd), 0) AS aum FROM v_firms ${whereSql}`)
    .bind(...binds).first<{ n: number; aum: number }>();
  // Median check size — D1 has no PERCENTILE_CONT, so emulate with ORDER+LIMIT.
  const sizesR = await c.env.DB
    .prepare(`SELECT check_size_typical_usd AS v FROM v_firms ${whereSql ? whereSql + " AND" : "WHERE"} check_size_typical_usd IS NOT NULL ORDER BY check_size_typical_usd`)
    .bind(...binds).all<{ v: number }>();
  const sizes = (sizesR.results ?? []).map((r) => r.v);
  const median = sizes.length
    ? (sizes.length % 2
        ? sizes[(sizes.length - 1) >> 1]
        : Math.round((sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2))
    : 0;
  const cityR = await c.env.DB
    .prepare(`SELECT hq_city AS k, COUNT(*) AS n FROM v_firms ${whereSql ? whereSql + " AND" : "WHERE"} hq_city IS NOT NULL AND hq_city != '' GROUP BY hq_city ORDER BY n DESC LIMIT 3`)
    .bind(...binds).all<{ k: string; n: number }>();
  // Sectors: explode by counting LIKE-matches per known slug. We pull every
  // sector_json once and reduce in-memory — scoped to the current filter set
  // so this stays O(filtered rows) rather than O(all firms).
  const allSecR = await c.env.DB
    .prepare(`SELECT sectors_json FROM v_firms ${whereSql}`)
    .bind(...binds).all<{ sectors_json: string | null }>();
  const counts: Record<string, number> = {};
  for (const row of allSecR.results ?? []) {
    if (!row.sectors_json) continue;
    try {
      const arr = JSON.parse(row.sectors_json);
      if (!Array.isArray(arr)) continue;
      for (const s of arr) if (typeof s === "string") counts[s] = (counts[s] || 0) + 1;
    } catch { /* skip malformed */ }
  }
  const topSectors = Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([slug, n]) => ({ slug, count: n }));
  return c.json({
    count: totalRow?.n ?? 0,
    total_aum_usd: totalRow?.aum ?? 0,
    median_check_size_usd: median,
    top_cities: cityR.results ?? [],
    top_sectors: topSectors,
  });
});

// --------- GET BY ID (with people[] + portfolio[]) ---------
firms.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const firm = await c.env.DB.prepare("SELECT * FROM v_firms WHERE id = ?").bind(id).first();
  if (!firm) return c.json({ error: "not_found" }, 404);

  const people = await c.env.DB
    .prepare(
      `SELECT fp.id AS firm_people_id, fp.role, fp.is_decision_maker, fp.started_at, fp.ended_at, fp.source_url AS link_source_url,
              l.id, l.name, l.email, l.title, l.org, l.linkedin_url, l.twitter_url, l.persona_role, l.seniority,
              l.country_iso2, l.region, l.city, l.last_enriched_at
       FROM v_firm_people fp
       LEFT JOIN v_leads l ON l.id = fp.lead_id
       WHERE fp.firm_id = ?
       ORDER BY fp.is_decision_maker DESC, fp.id ASC`,
    )
    .bind(id)
    .all();
  const portfolio = await c.env.DB
    .prepare("SELECT * FROM v_firm_portfolio WHERE firm_id = ? ORDER BY investment_year DESC, id DESC")
    .bind(id)
    .all();
  return c.json({ ...firm, people: people.results ?? [], portfolio: portfolio.results ?? [] });
});

// --------- CREATE ---------
firms.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "bad_request", message: "name required" }, 400);
  }
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const f of FIRM_FIELDS) {
    if (f in body) { cols.push(f); values.push(jsonish(body[f]) ?? null); }
  }
  if (!cols.includes("slug")) {
    cols.push("slug"); values.push(slugify(String(body.name)));
  }
  const placeholders = cols.map(() => "?").join(",");
  const r = await c.env.DB
    .prepare(`INSERT INTO firms (${cols.join(",")}) VALUES (${placeholders})`)
    .bind(...values)
    .run();
  const newId = (r.meta.last_row_id as number) ?? null;
  const created = newId != null
    ? await c.env.DB.prepare("SELECT * FROM v_firms WHERE id = ?").bind(newId).first()
    : null;
  if (created) {
    try {
      const { syncFirmToEntity } = await import("../entities/dualwrite");
      await syncFirmToEntity(c.env, created as never, "firms_route_post");
    } catch (e) {
      console.warn("syncFirmToEntity (POST) failed", newId, (e as Error).message);
    }
  }
  return c.json(created, 201);
});

// --------- PATCH (with audit) ---------
firms.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "bad_request" }, 400);

  const before = await c.env.DB
    .prepare("SELECT * FROM v_firms WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!before) return c.json({ error: "not_found" }, 404);

  const setParts: string[] = [];
  const setValues: unknown[] = [];
  const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  for (const k of Object.keys(body)) {
    if (!FIRM_FIELD_SET.has(k)) continue;
    const next = jsonish(body[k]) ?? null;
    const prev = before[k] ?? null;
    if (normalize(next) === normalize(prev)) continue;
    setParts.push(`${k} = ?`);
    setValues.push(next);
    changes.push({ field: k, oldValue: prev, newValue: next });
  }
  if (!setParts.length) return c.json({ ok: true, changed: 0 });

  const now = new Date().toISOString();
  setParts.push("last_modified = ?");
  setValues.push(now);
  setValues.push(id);
  await c.env.DB
    .prepare(`UPDATE firms SET ${setParts.join(", ")} WHERE id = ?`)
    .bind(...setValues)
    .run();

  try {
    const updated = await c.env.DB.prepare("SELECT * FROM firms WHERE id = ?").bind(id).first();
    if (updated) {
      const { syncFirmToEntity } = await import("../entities/dualwrite");
      await syncFirmToEntity(c.env, updated as never, "firms_route_patch");
    }
  } catch (e) {
    console.warn("syncFirmToEntity (PATCH) failed", id, (e as Error).message);
  }

  const email = c.get("email");
  const stmts = changes.map((ch) =>
    c.env.DB
      .prepare(
        `INSERT INTO firm_history (id, firm_id, field, old_value, new_value, source, evidence_url, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        ch.field,
        ch.oldValue == null ? null : String(ch.oldValue),
        ch.newValue == null ? null : String(ch.newValue),
        "ui:patch",
        null,
        email ?? null,
        now,
      ),
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, changed: changes.length });
});

// --------- HISTORY ---------
firms.get("/:id/history", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const r = await c.env.DB
    .prepare(
      `SELECT id, field, old_value, new_value, source, evidence_url, changed_by, changed_at
       FROM firm_history WHERE firm_id = ? ORDER BY changed_at DESC LIMIT 200`,
    )
    .bind(id)
    .all();
  return c.json({ items: r.results ?? [] });
});

// --------- SOURCES (server-side join from fetch_log) ---------
// Direct join on host extracted from the firm's website/domain. We resolve
// the host server-side rather than asking the client to do it so the URL
// stays cacheable and we can apply RBAC + tier labels in one shot.
firms.get("/:id/sources", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? "50")));
  const firm = await c.env.DB
    .prepare("SELECT domain, website FROM v_firms WHERE id = ?")
    .bind(id).first<{ domain: string | null; website: string | null }>();
  if (!firm) return c.json({ error: "not_found" }, 404);
  let host = (firm.domain || "").trim().toLowerCase();
  if (!host && firm.website) {
    try { host = new URL(firm.website).host.toLowerCase(); } catch { /* invalid url */ }
  }
  if (!host) return c.json({ items: [], host: null });
  // Strip leading www. so the join hits regardless of canonicalization.
  const hostBare = host.replace(/^www\./, "");
  const r = await c.env.DB
    .prepare(
      `SELECT url, tier, status, bytes, block_reason, duration_ms, created_at
       FROM fetch_log
       WHERE host = ? OR host = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(host, "www." + hostBare, limit)
    .all<{ url: string; tier: number; status: number; bytes: number; block_reason: string | null; duration_ms: number; created_at: string }>();
  const TIER = ["direct", "browser", "proxy", "scraping_api", "wayback", "brave_cache"];
  const items = (r.results ?? []).map((row) => ({
    ...row,
    tier_label: TIER[row.tier] ?? String(row.tier),
  }));
  return c.json({ host, items });
});

// --------- ATTACH PERSON ---------
firms.post("/:id/people", async (c) => {
  const firmId = Number(c.req.param("id"));
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const body = (await c.req.json().catch(() => null)) as
    | { lead_id?: unknown; role?: unknown; is_decision_maker?: unknown; started_at?: unknown; ended_at?: unknown; source_url?: unknown }
    | null;
  if (!body || typeof body.lead_id !== "string" || !body.lead_id.trim()) {
    return c.json({ error: "bad_request", message: "lead_id required" }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT id FROM v_firms WHERE id = ?").bind(firmId).first();
  if (!exists) return c.json({ error: "not_found" }, 404);
  const role = typeof body.role === "string" ? body.role : null;
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO firm_people (firm_id, lead_id, role, is_decision_maker, started_at, ended_at, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        firmId,
        body.lead_id,
        role,
        body.is_decision_maker ? 1 : 0,
        typeof body.started_at === "string" ? body.started_at : null,
        typeof body.ended_at === "string" ? body.ended_at : null,
        typeof body.source_url === "string" ? body.source_url : null,
      )
      .run();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("UNIQUE")) return c.json({ error: "duplicate" }, 409);
    throw e;
  }
  return c.json({ ok: true }, 201);
});

// --------- DETACH PERSON ---------
firms.delete("/:id/people/:leadId", async (c) => {
  const firmId = Number(c.req.param("id"));
  const leadId = c.req.param("leadId");
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const r = await c.env.DB
    .prepare("DELETE FROM firm_people WHERE firm_id = ? AND lead_id = ?")
    .bind(firmId, leadId)
    .run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

// --------- ADD PORTFOLIO COMPANY ---------
firms.post("/:id/portfolio", async (c) => {
  const firmId = Number(c.req.param("id"));
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.company_name !== "string" || !body.company_name.trim()) {
    return c.json({ error: "bad_request", message: "company_name required" }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT id FROM v_firms WHERE id = ?").bind(firmId).first();
  if (!exists) return c.json({ error: "not_found" }, 404);
  const r = await c.env.DB
    .prepare(
      `INSERT INTO firm_portfolio
        (firm_id, company_name, company_domain, company_url, investment_year, stage, amount_usd, is_lead, outcome, exit_value_usd, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      firmId,
      String(body.company_name).trim(),
      typeof body.company_domain === "string" ? body.company_domain : null,
      typeof body.company_url === "string" ? body.company_url : null,
      typeof body.investment_year === "number" ? body.investment_year : null,
      typeof body.stage === "string" ? body.stage : null,
      typeof body.amount_usd === "number" ? body.amount_usd : null,
      body.is_lead ? 1 : 0,
      typeof body.outcome === "string" ? body.outcome : null,
      typeof body.exit_value_usd === "number" ? body.exit_value_usd : null,
      typeof body.source_url === "string" ? body.source_url : null,
    )
    .run();
  const id = (r.meta.last_row_id as number) ?? null;
  return c.json({ ok: true, id }, 201);
});

// --------- TRIGGER TEAM-PAGE CRAWL (Task #17) ---------
firms.post("/:id/crawl-team", async (c) => {
  const firmId = Number(c.req.param("id"));
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const firm = await c.env.DB
    .prepare("SELECT id, name, website, domain FROM v_firms WHERE id = ?")
    .bind(firmId)
    .first<{ id: number; name: string; website: string | null; domain: string | null }>();
  if (!firm) return c.json({ error: "not_found" }, 404);
  // Refuse when there is nothing to crawl. The processor itself synthesizes
  // the homepage from website/domain — we just gate enqueue here.
  if (!firm.website && !firm.domain) {
    return c.json({ error: "bad_request", message: "firm has no website or domain" }, 400);
  }

  // Spec contract: firm_team_crawl uses target=String(firmId).
  const target = String(firm.id);
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const source = firm.domain ?? "";
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'firm_team_crawl', ?, ?, ?, ?)`,
  ).bind(
    jobId,
    `firm_team_crawl:${firm.name}`,
    source,
    target,
    JSON.stringify({ firmId: firm.id, requested_by: c.get("email") ?? null }),
    now,
    now,
  ).run();
  await c.env.LEAD_QUEUE.send({
    jobId,
    kind: "firm_team_crawl",
    target,
    config: { firmId: firm.id },
  });
  return c.json({ ok: true, job_id: jobId }, 202);
});

// --------- BACKFILL FROM LEADS (admin one-shot) ---------
firms.post("/_backfill", async (c) => {
  const summary = await backfillFirmsFromLeads(c.env);
  return c.json({ ok: true, ...summary });
});
