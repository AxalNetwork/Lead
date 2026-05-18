// Task #4: VC / PE / Angel Intelligence Dashboard — read-only API
// surface aggregating the upstream ledgers (deal_events,
// partner_movements, funds, lp_fund_commitments, pe_deals, sec_filings,
// angels) into the eight dashboard views.
//
// Architecture constraints (replit.md Task #4):
//   - Read-only: this route never writes to entity tables. The one
//     write surface is /snapshots (owner-scoped freeze of a result
//     set) and that goes through the dashboard_snapshots table only.
//   - Watchlist infra is the only alert engine: no alert evaluator
//     here. Saved alerts go through the existing alert_rules table
//     with the new trigger kinds defined in monitoring/triggers/.
//   - Every endpoint supports ?format=csv with row-count parity to
//     the JSON response (acceptance probe #5).
//
// All endpoints sit behind accessGuard (mounted in index.ts) so the
// page-level gating in the Jekyll site has a 401/403 to gate on.

import { Hono } from "hono";
import type { Env } from "../types";
import { computeDryPowder } from "../services/funds/dryPowder";

export const dashboards = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function ownerEmail(c: { get: (k: string) => string }) { return c.get("email"); }

function csvEscape(s: unknown): string {
  const v = s == null ? "" : String(s);
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function csvResponse(rows: Record<string, unknown>[], headers: string[], filename: string): Response {
  const head = headers.join(",");
  const body = rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")).join("\n");
  return new Response(rows.length ? `${head}\n${body}\n` : `${head}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
    },
  });
}

function safeJson<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function monthBucket(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.slice(0, 7); // YYYY-MM
}

// ---------------- /kpi: landing KPI strip ----------------
// Returns counts + totals for the last 7d / 30d windows. Used by the
// capital-markets landing page hero strip. Each KPI links to its
// drill-down (the dashboard page that hydrates from these same APIs).
dashboards.get("/kpi", async (c) => {
  const d7 = "datetime('now','-7 day')";
  const d30 = "datetime('now','-30 day')";
  const [deals7, deals30, raised30, moves7, fundsRaising, ipoFilings30, ma30] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM deal_events WHERE event_type='funding_round' AND datetime(announcement_date) >= ${d7}`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM deal_events WHERE event_type='funding_round' AND datetime(announcement_date) >= ${d30}`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount_usd),0) AS s FROM deal_events WHERE event_type='funding_round' AND datetime(announcement_date) >= ${d30}`).first<{ s: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM partner_movements WHERE datetime(observed_at) >= ${d7}`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM funds WHERE fund_status='raising'`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM deal_events WHERE event_type='ipo' AND datetime(announcement_date) >= ${d30}`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM deal_events WHERE event_type IN ('acquisition','merger') AND datetime(announcement_date) >= ${d30}`).first<{ n: number }>(),
  ]);
  return c.json({
    deals_7d: deals7?.n ?? 0,
    deals_30d: deals30?.n ?? 0,
    total_raised_usd_30d: raised30?.s ?? 0,
    partner_moves_7d: moves7?.n ?? 0,
    funds_raising: fundsRaising?.n ?? 0,
    ipo_filings_30d: ipoFilings30?.n ?? 0,
    ma_events_30d: ma30?.n ?? 0,
    as_of: new Date().toISOString(),
  });
});

// Deal feed (chronological) — capital-markets landing left column.
dashboards.get("/feeds/deals", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "30"), 100);
  const r = await c.env.DB.prepare(
    `SELECT d.id, d.event_type, d.company_entity_id, d.company_name_raw,
            d.amount_usd, d.round_name, d.announcement_date,
            d.sector_tags_json, d.source_url, d.source_type, d.geography
       FROM deal_events d
       ORDER BY d.announcement_date DESC LIMIT ?`,
  ).bind(limit).all<{
    id: string; event_type: string; company_entity_id: string | null;
    company_name_raw: string; amount_usd: number | null; round_name: string | null;
    announcement_date: string | null; sector_tags_json: string | null;
    source_url: string | null; source_type: string | null; geography: string | null;
  }>();
  const items = (r.results ?? []).map((row) => ({
    ...row, sector_tags: safeJson<string[]>(row.sector_tags_json) ?? [],
  }));
  if (c.req.query("format") === "csv") {
    return csvResponse(items as unknown as Record<string, unknown>[],
      ["announcement_date", "event_type", "company_name_raw", "round_name", "amount_usd", "geography", "source_url"],
      "deals-feed");
  }
  return c.json({ items });
});

// Movement feed (partner moves + spinouts + new fund closes).
dashboards.get("/feeds/movements", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "30"), 100);
  const movements = await c.env.DB.prepare(
    `SELECT id, person_name_raw, movement_type, from_firm_entity_id, to_firm_entity_id,
            from_title, to_title, observed_at, source_url, status
       FROM partner_movements WHERE status != 'rejected'
       ORDER BY observed_at DESC LIMIT ?`,
  ).bind(limit).all<Record<string, unknown>>();
  if (c.req.query("format") === "csv") {
    const rows = (movements.results ?? []) as Record<string, unknown>[];
    return csvResponse(rows,
      ["observed_at", "person_name_raw", "movement_type", "from_firm_entity_id", "to_firm_entity_id", "to_title", "source_url"],
      "movements-feed");
  }
  return c.json({ items: movements.results ?? [] });
});

// ---------------- /dry-powder-map: bubble per firm ----------------
// One bubble per firm whose funds.dry_powder_estimate is non-null.
// We compute on the fly via computeDryPowder() since the funds table
// doesn't carry a precomputed column (the routes/funds.ts code is the
// canonical estimator). Bubbles are sized by aggregate mid-band $.
dashboards.get("/dry-powder-map", async (c) => {
  const cap = Math.min(Number(c.req.query("limit") ?? "100"), 200);
  // Pull active funds with a positive announced raised — dry-powder is
  // only meaningful for funds that have raised capital.
  const fundRows = await c.env.DB.prepare(
    `SELECT f.id, f.firm_entity_id, f.fund_name, f.announced_raised_usd,
            f.vintage_year, f.strategy,
            e.display_name AS firm_name
       FROM funds f
       LEFT JOIN u_entities e ON e.id = f.firm_entity_id
      WHERE f.fund_status IN ('raising','active')
        AND f.announced_raised_usd > 0
      ORDER BY f.announced_raised_usd DESC LIMIT ?`,
  ).bind(cap).all<{
    id: string; firm_entity_id: string; fund_name: string;
    announced_raised_usd: number | null; vintage_year: number | null;
    strategy: string | null; firm_name: string | null;
  }>();
  const perFirm = new Map<string, { firm_entity_id: string; firm_name: string; dry_powder_usd: number; fund_count: number; strategy: string | null }>();
  for (const f of fundRows.results ?? []) {
    const band = await computeDryPowder(c.env, f.id);
    if (!band || band.mid <= 0) continue;
    const cur = perFirm.get(f.firm_entity_id) ?? {
      firm_entity_id: f.firm_entity_id,
      firm_name: f.firm_name ?? f.firm_entity_id,
      dry_powder_usd: 0, fund_count: 0, strategy: f.strategy,
    };
    cur.dry_powder_usd += band.mid;
    cur.fund_count += 1;
    perFirm.set(f.firm_entity_id, cur);
  }
  const items = [...perFirm.values()].sort((a, b) => b.dry_powder_usd - a.dry_powder_usd);
  if (c.req.query("format") === "csv") {
    return csvResponse(items as unknown as Record<string, unknown>[],
      ["firm_entity_id", "firm_name", "dry_powder_usd", "fund_count", "strategy"],
      "dry-powder-map");
  }
  return c.json({ items, total_firms: items.length });
});

// ---------------- /funds-raising ----------------
// Table of funds with fund_status='raising' + live filters
// (sector / geo / strategy / target-size band). Acceptance probe #3.
dashboards.get("/funds-raising", async (c) => {
  const sector = c.req.query("sector");
  const geo = c.req.query("geo");
  const strategy = c.req.query("strategy");
  const minTarget = c.req.query("min_target_usd");
  const maxTarget = c.req.query("max_target_usd");
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);

  const wheres = ["f.fund_status = 'raising'"];
  const binds: unknown[] = [];
  if (strategy) { wheres.push("f.strategy = ?"); binds.push(strategy); }
  if (minTarget) { wheres.push("f.target_size_usd >= ?"); binds.push(Number(minTarget)); }
  if (maxTarget) { wheres.push("f.target_size_usd <= ?"); binds.push(Number(maxTarget)); }
  if (sector) { wheres.push("f.sectors_json LIKE ?"); binds.push(`%"${sector}"%`); }
  if (geo) { wheres.push("f.geos_json LIKE ?"); binds.push(`%"${geo}"%`); }

  const r = await c.env.DB.prepare(
    `SELECT f.id, f.firm_entity_id, f.fund_name, f.fund_number, f.vintage_year,
            f.target_size_usd, f.announced_raised_usd, f.strategy,
            f.sectors_json, f.geos_json, f.final_close_date,
            e.display_name AS firm_name
       FROM funds f
       LEFT JOIN u_entities e ON e.id = f.firm_entity_id
      WHERE ${wheres.join(" AND ")}
      ORDER BY f.target_size_usd DESC NULLS LAST LIMIT ?`,
  ).bind(...binds, limit).all<{
    id: string; firm_entity_id: string; fund_name: string; fund_number: number | null;
    vintage_year: number | null; target_size_usd: number | null; announced_raised_usd: number | null;
    strategy: string | null; sectors_json: string | null; geos_json: string | null;
    final_close_date: string | null; firm_name: string | null;
  }>();
  const items = (r.results ?? []).map((row) => ({
    ...row,
    sectors: safeJson<string[]>(row.sectors_json) ?? [],
    geos: safeJson<string[]>(row.geos_json) ?? [],
    pct_raised: row.announced_raised_usd && row.target_size_usd
      ? Math.min(100, Math.round((row.announced_raised_usd / row.target_size_usd) * 100))
      : null,
  }));
  if (c.req.query("format") === "csv") {
    return csvResponse(items as unknown as Record<string, unknown>[],
      ["firm_name", "fund_name", "fund_number", "vintage_year", "target_size_usd", "announced_raised_usd", "pct_raised", "strategy"],
      "funds-raising");
  }
  return c.json({ items, count: items.length });
});

// ---------------- /lp-network: bipartite LP ↔ fund ----------------
dashboards.get("/lp-network", async (c) => {
  const lpClass = c.req.query("lp_class");
  const vintage = c.req.query("vintage_year");
  const limit = Math.min(Number(c.req.query("limit") ?? "500"), 2000);

  const wheres = ["c.committed_usd > 0"];
  const binds: unknown[] = [];
  if (vintage) { wheres.push("c.vintage_year = ?"); binds.push(Number(vintage)); }
  // lp_class is stored as an `lp.class` fact — join via facts.
  let joinFacts = "";
  if (lpClass) {
    joinFacts = `JOIN facts ff ON ff.entity_id = c.lp_entity_id
                                AND ff.predicate = 'lp.class'
                                AND ff.value_text = ?`;
    binds.push(lpClass);
  }
  const r = await c.env.DB.prepare(
    `SELECT c.lp_entity_id, c.fund_entity_id, c.fund_name_raw,
            c.committed_usd, c.vintage_year, c.as_of_date,
            elp.display_name AS lp_name,
            ef.display_name AS fund_name
       FROM lp_fund_commitments c
       LEFT JOIN u_entities elp ON elp.id = c.lp_entity_id
       LEFT JOIN u_entities ef ON ef.id = c.fund_entity_id
       ${joinFacts}
      WHERE ${wheres.join(" AND ")}
      ORDER BY c.committed_usd DESC LIMIT ?`,
  ).bind(...binds, limit).all<Record<string, unknown>>();
  const edges = (r.results ?? []) as Array<{
    lp_entity_id: string; fund_entity_id: string | null; fund_name_raw: string;
    committed_usd: number; vintage_year: number | null; as_of_date: string;
    lp_name: string | null; fund_name: string | null;
  }>;
  const lps = new Map<string, { id: string; name: string; total_committed_usd: number }>();
  const funds = new Map<string, { id: string; name: string; total_committed_usd: number }>();
  for (const e of edges) {
    const lp = lps.get(e.lp_entity_id) ?? { id: e.lp_entity_id, name: e.lp_name ?? e.lp_entity_id, total_committed_usd: 0 };
    lp.total_committed_usd += e.committed_usd;
    lps.set(e.lp_entity_id, lp);
    const fk = e.fund_entity_id ?? e.fund_name_raw;
    const f = funds.get(fk) ?? { id: fk, name: e.fund_name ?? e.fund_name_raw, total_committed_usd: 0 };
    f.total_committed_usd += e.committed_usd;
    funds.set(fk, f);
  }
  if (c.req.query("format") === "csv") {
    return csvResponse(edges as unknown as Record<string, unknown>[],
      ["lp_name", "fund_name", "committed_usd", "vintage_year", "as_of_date"], "lp-network");
  }
  return c.json({ lps: [...lps.values()], funds: [...funds.values()], edges });
});

// ---------------- /partner-moves: sankey ----------------
dashboards.get("/partner-moves", async (c) => {
  const monthsBack = Math.min(Number(c.req.query("months_back") ?? "6"), 36);
  const firm = c.req.query("firm");
  const wheres = ["status = 'confirmed'",
    "datetime(observed_at) >= datetime('now', ?)"];
  const binds: unknown[] = [`-${monthsBack} month`];
  if (firm) {
    wheres.push("(from_firm_entity_id = ? OR to_firm_entity_id = ?)");
    binds.push(firm, firm);
  }
  const r = await c.env.DB.prepare(
    `SELECT id, person_entity_id, person_name_raw, from_firm_entity_id, to_firm_entity_id,
            from_title, to_title, observed_at, movement_type
       FROM partner_movements WHERE ${wheres.join(" AND ")}
       ORDER BY observed_at DESC LIMIT 1000`,
  ).bind(...binds).all<Record<string, unknown>>();
  const items = r.results ?? [];
  // Aggregate by (from_firm, to_firm) for the sankey nodes/links.
  const links = new Map<string, { from_firm_entity_id: string; to_firm_entity_id: string; count: number; people: string[] }>();
  for (const m of items as Array<{ from_firm_entity_id: string | null; to_firm_entity_id: string | null; person_name_raw: string }>) {
    if (!m.from_firm_entity_id || !m.to_firm_entity_id) continue;
    const k = `${m.from_firm_entity_id}→${m.to_firm_entity_id}`;
    const e = links.get(k) ?? { from_firm_entity_id: m.from_firm_entity_id, to_firm_entity_id: m.to_firm_entity_id, count: 0, people: [] };
    e.count += 1;
    if (e.people.length < 8) e.people.push(m.person_name_raw);
    links.set(k, e);
  }
  if (c.req.query("format") === "csv") {
    return csvResponse(items as unknown as Record<string, unknown>[],
      ["observed_at", "person_name_raw", "movement_type", "from_firm_entity_id", "to_firm_entity_id", "to_title"],
      "partner-moves");
  }
  return c.json({ items, links: [...links.values()] });
});

// ---------------- /vintage-benchmarks: box-plot ----------------
dashboards.get("/vintage-benchmarks", async (c) => {
  const metric = (c.req.query("metric") ?? "net_irr_pct") as "net_irr_pct" | "tvpi" | "dpi";
  if (!["net_irr_pct", "tvpi", "dpi"].includes(metric)) {
    return c.json({ error: "bad_metric" }, 400);
  }
  // Pull all commitments with a value for the metric + a vintage_year.
  const r = await c.env.DB.prepare(
    `SELECT c.vintage_year, f.strategy, c.${metric} AS v, c.fund_entity_id
       FROM lp_fund_commitments c
       LEFT JOIN funds f ON f.fund_entity_id = c.fund_entity_id
      WHERE c.vintage_year IS NOT NULL AND c.${metric} IS NOT NULL
      ORDER BY c.vintage_year ASC`,
  ).all<{ vintage_year: number; strategy: string | null; v: number; fund_entity_id: string | null }>();
  const buckets = new Map<string, number[]>();
  for (const row of r.results ?? []) {
    const k = `${row.vintage_year}|${row.strategy ?? "unknown"}`;
    const arr = buckets.get(k) ?? [];
    arr.push(row.v);
    buckets.set(k, arr);
  }
  function quantiles(xs: number[]) {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, min: s[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: s[s.length - 1] };
  }
  const items = [...buckets.entries()].map(([k, xs]) => {
    const [vy, strat] = k.split("|");
    return { vintage_year: Number(vy), strategy: strat, ...quantiles(xs) };
  });
  if (c.req.query("format") === "csv") {
    return csvResponse(items as unknown as Record<string, unknown>[],
      ["vintage_year", "strategy", "n", "min", "q1", "median", "q3", "max"],
      `vintage-${metric}`);
  }
  return c.json({ metric, items });
});

// ---------------- /sector-momentum: heatmap ----------------
dashboards.get("/sector-momentum", async (c) => {
  const monthsBack = Math.min(Number(c.req.query("months_back") ?? "12"), 36);
  const r = await c.env.DB.prepare(
    `SELECT sector_tags_json, amount_usd, announcement_date
       FROM deal_events
      WHERE event_type='funding_round'
        AND datetime(announcement_date) >= datetime('now', ?)
        AND sector_tags_json IS NOT NULL`,
  ).bind(`-${monthsBack} month`).all<{ sector_tags_json: string; amount_usd: number | null; announcement_date: string | null }>();
  type Cell = { sector: string; month: string; deal_count: number; total_usd: number };
  const cells = new Map<string, Cell>();
  for (const row of r.results ?? []) {
    const tags = safeJson<string[]>(row.sector_tags_json) ?? [];
    const month = monthBucket(row.announcement_date);
    if (!month) continue;
    for (const s of tags) {
      const key = `${s}|${month}`;
      const cur = cells.get(key) ?? { sector: s, month, deal_count: 0, total_usd: 0 };
      cur.deal_count += 1;
      cur.total_usd += row.amount_usd ?? 0;
      cells.set(key, cur);
    }
  }
  const items = [...cells.values()].sort((a, b) => a.sector.localeCompare(b.sector) || a.month.localeCompare(b.month));
  if (c.req.query("format") === "csv") {
    return csvResponse(items as unknown as Record<string, unknown>[],
      ["sector", "month", "deal_count", "total_usd"], "sector-momentum");
  }
  return c.json({ items });
});

// ---------------- /geographic-flow: investor→portco arcs ----------------
dashboards.get("/geographic-flow", async (c) => {
  const monthsBack = Math.min(Number(c.req.query("months_back") ?? "6"), 36);
  // Join deal_participants → investor (geo via entity_summary) and
  // deal_events.geography (portco). Aggregate by (investor_geo,
  // portco_geo) pair.
  const r = await c.env.DB.prepare(
    `SELECT d.geography AS portco_geo, d.amount_usd,
            COALESCE(es.country_iso2, es.city, '?') AS investor_geo
       FROM deal_events d
       JOIN deal_participants dp ON dp.deal_id = d.id
       LEFT JOIN entity_summary es ON es.entity_id = dp.investor_entity_id
      WHERE d.event_type='funding_round'
        AND datetime(d.announcement_date) >= datetime('now', ?)
        AND d.geography IS NOT NULL`,
  ).bind(`-${monthsBack} month`).all<{ portco_geo: string; amount_usd: number | null; investor_geo: string }>();
  const arcs = new Map<string, { from: string; to: string; deal_count: number; total_usd: number }>();
  for (const row of r.results ?? []) {
    const k = `${row.investor_geo}→${row.portco_geo}`;
    const cur = arcs.get(k) ?? { from: row.investor_geo, to: row.portco_geo, deal_count: 0, total_usd: 0 };
    cur.deal_count += 1;
    cur.total_usd += row.amount_usd ?? 0;
    arcs.set(k, cur);
  }
  const items = [...arcs.values()].sort((a, b) => b.total_usd - a.total_usd);
  if (c.req.query("format") === "csv") {
    return csvResponse(items as unknown as Record<string, unknown>[],
      ["from", "to", "deal_count", "total_usd"], "geo-flow");
  }
  return c.json({ items });
});

// ---------------- /angel-finder: filtered angel search ----------------
dashboards.get("/angel-finder", async (c) => {
  const sector = c.req.query("sector");
  const geo = c.req.query("geo");
  const angelType = c.req.query("angel_type");
  const openWarm = c.req.query("open_to_warm_intros");
  const dayJob = c.req.query("day_job_entity_id");
  const syndicate = c.req.query("syndicate_handle");
  const minCheck = c.req.query("min_check_usd");
  const maxCheck = c.req.query("max_check_usd");
  const q = c.req.query("q");
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);

  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (angelType) { wheres.push("a.angel_type = ?"); binds.push(angelType); }
  if (openWarm === "1" || openWarm === "true") { wheres.push("a.open_to_warm_intros = 1"); }
  if (dayJob) { wheres.push("a.day_job_entity_id = ?"); binds.push(dayJob); }
  if (syndicate) { wheres.push("a.syndicate_handle = ?"); binds.push(syndicate); }
  if (minCheck) { wheres.push("a.typical_check_min_usd >= ?"); binds.push(Number(minCheck)); }
  if (maxCheck) { wheres.push("a.typical_check_max_usd <= ?"); binds.push(Number(maxCheck)); }
  if (sector) { wheres.push("a.preferred_sectors_json LIKE ?"); binds.push(`%"${sector}"%`); }
  if (geo) { wheres.push("a.preferred_geos_json LIKE ?"); binds.push(`%"${geo}"%`); }
  if (q) { wheres.push("(e.display_name LIKE ? OR a.person_entity_id LIKE ?)"); binds.push(`%${q}%`, `%${q}%`); }
  const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const r = await c.env.DB.prepare(
    `SELECT a.person_entity_id, a.angel_type, a.day_job_entity_id, a.day_job_role,
            a.typical_check_min_usd, a.typical_check_max_usd, a.preferred_sectors_json,
            a.preferred_geos_json, a.portfolio_count, a.syndicate_handle,
            a.open_to_warm_intros, a.last_investment_at,
            e.display_name AS person_name,
            ej.display_name AS day_job_firm_name
       FROM angels a
       LEFT JOIN u_entities e ON e.id = a.person_entity_id
       LEFT JOIN u_entities ej ON ej.id = a.day_job_entity_id
       ${where}
      ORDER BY a.last_investment_at DESC NULLS LAST LIMIT ?`,
  ).bind(...binds, limit).all<Record<string, unknown>>();
  const items = (r.results ?? []).map((row) => ({
    ...row,
    preferred_sectors: safeJson<string[]>(row.preferred_sectors_json as string | null) ?? [],
    preferred_geos: safeJson<string[]>(row.preferred_geos_json as string | null) ?? [],
  }));
  if (c.req.query("format") === "csv") {
    return csvResponse(items as Record<string, unknown>[],
      ["person_name", "angel_type", "day_job_firm_name", "day_job_role",
        "typical_check_min_usd", "typical_check_max_usd", "portfolio_count",
        "syndicate_handle", "open_to_warm_intros", "last_investment_at"], "angels");
  }
  return c.json({ items, count: items.length });
});

// ---------------- /snapshots: freeze a result set ----------------
// POST {page, filters, payload, row_count} → creates owner-scoped
// snapshot. The snapshot is served verbatim from GET /snapshots/:id
// — the read path NEVER re-queries underlying tables (acceptance
// probe #6). Large payloads spill to R2 (UPLOADS bucket).
const INLINE_PAYLOAD_LIMIT = 80_000;

dashboards.post("/snapshots", async (c) => {
  const email = ownerEmail(c);
  const body = await c.req.json().catch(() => null) as {
    page?: unknown; filters?: unknown; payload?: unknown; row_count?: unknown;
  } | null;
  if (!body || typeof body.page !== "string") {
    return c.json({ error: "bad_request", message: "page required" }, 400);
  }
  const id = crypto.randomUUID();
  const payloadStr = JSON.stringify(body.payload ?? null);
  const filtersStr = JSON.stringify(body.filters ?? {});
  let inlineJson: string | null = payloadStr;
  let payloadUri: string | null = null;
  if (payloadStr.length > INLINE_PAYLOAD_LIMIT) {
    payloadUri = `dashboards/snapshots/${id}.json`;
    await c.env.UPLOADS.put(payloadUri, payloadStr, {
      httpMetadata: { contentType: "application/json" },
    });
    inlineJson = null;
  }
  const rowCount = typeof body.row_count === "number" ? body.row_count : 0;
  await c.env.DB.prepare(
    `INSERT INTO dashboard_snapshots (id, owner_email, page, filters_json, payload_json, payload_uri, row_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, email, body.page, filtersStr, inlineJson, payloadUri, rowCount).run();
  return c.json({ id, ok: true }, 201);
});

dashboards.get("/snapshots/:id", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT page, filters_json, payload_json, payload_uri, row_count, created_at
       FROM dashboard_snapshots WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).first<{ page: string; filters_json: string; payload_json: string | null; payload_uri: string | null; row_count: number; created_at: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  let payload: unknown = null;
  if (row.payload_json) payload = safeJson(row.payload_json);
  else if (row.payload_uri) {
    const obj = await c.env.UPLOADS.get(row.payload_uri);
    if (obj) payload = await obj.json();
  }
  return c.json({
    id, page: row.page,
    filters: safeJson(row.filters_json),
    payload, row_count: row.row_count, created_at: row.created_at,
    note: "Snapshot served verbatim — underlying tables are NOT re-queried.",
  });
});

dashboards.get("/snapshots", async (c) => {
  const email = ownerEmail(c);
  const page = c.req.query("page");
  const wheres = ["owner_email = ?"];
  const binds: unknown[] = [email];
  if (page) { wheres.push("page = ?"); binds.push(page); }
  const r = await c.env.DB.prepare(
    `SELECT id, page, filters_json, row_count, created_at
       FROM dashboard_snapshots WHERE ${wheres.join(" AND ")}
       ORDER BY created_at DESC LIMIT 100`,
  ).bind(...binds).all();
  return c.json({ items: r.results ?? [] });
});
