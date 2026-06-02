// Task #20 — analytics endpoints for the firms dashboard.
// Heavy aggregates (heatmap/geo/sector_roi/connected) are read from the
// nightly-materialized firm_analytics_daily table; on cold/missing days we
// fall back to a live computation so the page never shows "no data" right
// after a deploy. Light aggregates (funnel, distribution, success_rate,
// timeline, coverage_gaps) compute live — they're cheap.
import { Hono } from "hono";
import type { Env } from "../types";
import { parseFirmFilter, buildFirmWhere } from "./_firms_filter";

export const analyticsFirms = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

async function readMaterialized(env: Env, kind: string): Promise<unknown | null> {
  const r = await env.DB
    .prepare(
      "SELECT payload_json FROM firm_analytics_daily WHERE kind = ? ORDER BY snapshot_date DESC LIMIT 1",
    )
    .bind(kind)
    .first<{ payload_json: string }>();
  if (!r) return null;
  try { return JSON.parse(r.payload_json); } catch { return null; }
}

// ---------------------------------------------------------------- funnel
// Imported -> enriched -> has-contact -> approved.
analyticsFirms.get("/funnel", async (c) => {
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM firms").first<{ n: number }>();
  const enriched = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM firms WHERE last_enriched_at IS NOT NULL")
    .first<{ n: number }>();
  const hasContact = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM firms WHERE contact_email IS NOT NULL AND contact_email != ''")
    .first<{ n: number }>();
  const approved = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM firms WHERE status = 'approved'")
    .first<{ n: number }>();
  const stages = [
    { status: "imported", count: total?.n ?? 0 },
    { status: "enriched", count: enriched?.n ?? 0 },
    { status: "has_contact", count: hasContact?.n ?? 0 },
    { status: "approved", count: approved?.n ?? 0 },
  ];
  return c.json({ stages });
});

// ---------------------------------------- check_size / aum distribution
async function distribution(env: Env, field: "check_size_typical_usd" | "aum_usd", buckets: number) {
  const range = await env.DB
    .prepare(`SELECT MIN(${field}) AS lo, MAX(${field}) AS hi FROM firms WHERE ${field} IS NOT NULL`)
    .first<{ lo: number; hi: number }>();
  if (!range || range.lo == null || range.hi == null || range.hi <= range.lo) {
    return { buckets: [], min: 0, max: 0 };
  }
  const lo = range.lo, hi = range.hi;
  const width = (hi - lo) / buckets;
  // Use CASE bucketing inline; D1 supports it.
  const r = await env.DB
    .prepare(
      `SELECT CAST(MIN(buckets - 1, ((${field} - ?) / ?)) AS INTEGER) AS b, COUNT(*) AS n
         FROM (SELECT ${buckets} AS buckets, ${field} FROM firms WHERE ${field} IS NOT NULL)
         GROUP BY b ORDER BY b`,
    )
    .bind(lo, width)
    .all<{ b: number; n: number }>();
  const out: { lo: number; hi: number; count: number }[] = [];
  for (let i = 0; i < buckets; i++) {
    const row = (r.results ?? []).find((x) => x.b === i);
    out.push({
      lo: Math.round(lo + i * width),
      hi: Math.round(lo + (i + 1) * width),
      count: row?.n ?? 0,
    });
  }
  return { buckets: out, min: lo, max: hi };
}

analyticsFirms.get("/distribution", async (c) => {
  const field = c.req.query("field") === "aum_usd" ? "aum_usd" : "check_size_typical_usd";
  const buckets = Math.min(50, Math.max(5, Number(c.req.query("buckets") ?? "20")));
  return c.json(await distribution(c.env, field, buckets));
});

// ---------------------------------------------------------------- heatmap
// Stages × sectors. Materialized nightly; falls back to live computation.
async function liveHeatmap(env: Env): Promise<{ stages: string[]; sectors: string[]; matrix: number[][] }> {
  const r = await env.DB.prepare("SELECT stages_json, sectors_json FROM firms").all<{ stages_json: string | null; sectors_json: string | null }>();
  const counts: Record<string, Record<string, number>> = {};
  const stageSet = new Set<string>(), sectorSet = new Set<string>();
  for (const row of r.results ?? []) {
    let stages: string[] = [], sectors: string[] = [];
    try { if (row.stages_json) stages = JSON.parse(row.stages_json); } catch {}
    try { if (row.sectors_json) sectors = JSON.parse(row.sectors_json); } catch {}
    if (!Array.isArray(stages) || !Array.isArray(sectors) || !stages.length || !sectors.length) continue;
    for (const st of stages) {
      if (typeof st !== "string") continue;
      stageSet.add(st);
      counts[st] = counts[st] || {};
      for (const sc of sectors) {
        if (typeof sc !== "string") continue;
        sectorSet.add(sc);
        counts[st][sc] = (counts[st][sc] || 0) + 1;
      }
    }
  }
  const stages = Array.from(stageSet).sort();
  const sectors = Array.from(sectorSet).sort();
  const matrix = stages.map((st) => sectors.map((sc) => counts[st]?.[sc] || 0));
  return { stages, sectors, matrix };
}
analyticsFirms.get("/heatmap", async (c) => {
  const cached = await readMaterialized(c.env, "heatmap");
  if (cached) return c.json(cached);
  return c.json(await liveHeatmap(c.env));
});

// ----------------------------------------------------------------- geo
async function liveGeo(env: Env): Promise<{ items: { country: string; count: number }[] }> {
  const r = await env.DB
    .prepare(
      `SELECT COALESCE(hq_country_iso2, '__unknown__') AS country, COUNT(*) AS n
         FROM firms GROUP BY country ORDER BY n DESC LIMIT 250`,
    )
    .all<{ country: string; n: number }>();
  return { items: (r.results ?? []).map((x) => ({ country: x.country, count: x.n })) };
}
analyticsFirms.get("/geo", async (c) => {
  const cached = await readMaterialized(c.env, "geo");
  if (cached) return c.json(cached);
  return c.json(await liveGeo(c.env));
});

// Task #13: admin-only manual trigger for the firm geo backfill. The same
// routine runs nightly (bounded at 1000/tick); this lets an operator force a
// large one-shot sweep without waiting. Admin is gated via `is_admin` set by
// accessGuard on /api/* (Task #14 inline-admin pattern), not a parallel
// middleware. Re-materializes the geo aggregate so the map reflects the new
// codes immediately.
analyticsFirms.post("/geo/backfill", async (c) => {
  if (c.var.is_admin !== true) return c.json({ error: "forbidden" }, 403);
  const { runFirmGeoBackfill } = await import("../scraper/geo_backfill");
  const reqLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(reqLimit) ? Math.min(100000, Math.max(1, reqLimit)) : 100000;
  const result = await runFirmGeoBackfill(c.env, { limit });
  try {
    await materializeFirmAnalytics(c.env);
  } catch (e) {
    console.warn("geo backfill re-materialize failed", (e as Error).message);
  }
  return c.json({ ok: true, ...result });
});

// ------------------------------------------- top-N most-connected firms
async function liveConnected(env: Env, limit: number) {
  const r = await env.DB
    .prepare(
      `SELECT f.id, f.name,
              (SELECT COUNT(*) FROM firm_people fp WHERE fp.firm_id = f.id) AS people_count,
              (SELECT COUNT(*) FROM firm_portfolio fp2 WHERE fp2.firm_id = f.id) AS portfolio_count_actual,
              ((SELECT COUNT(*) FROM firm_people fp WHERE fp.firm_id = f.id)
                + (SELECT COUNT(*) FROM firm_portfolio fp2 WHERE fp2.firm_id = f.id)) AS total
         FROM firms f
        ORDER BY total DESC, f.id DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: number; name: string; people_count: number; portfolio_count_actual: number; total: number }>();
  return { items: r.results ?? [] };
}
interface ConnectedPayload { items: Array<{ id: number; name: string; people_count: number; portfolio_count_actual: number; total: number }> }

analyticsFirms.get("/connected", async (c) => {
  const limit = Math.min(100, Math.max(5, Number(c.req.query("limit") ?? "20")));
  const cached = (await readMaterialized(c.env, "connected")) as ConnectedPayload | null;
  if (cached && Array.isArray(cached.items)) {
    return c.json({ items: cached.items.slice(0, limit) });
  }
  return c.json(await liveConnected(c.env, limit));
});

// ---------------------------------------------------------- success rate
analyticsFirms.get("/success-rate", async (c) => {
  const minPortfolio = Math.max(1, Number(c.req.query("min_portfolio") ?? "5"));
  const r = await c.env.DB
    .prepare(
      `SELECT id, name, exits_count, portfolio_count,
              (CASE WHEN COALESCE(portfolio_count, 0) > 0
                    THEN (COALESCE(exits_count, 0) * 1.0) / portfolio_count
                    ELSE 0 END) AS rate
         FROM firms
        WHERE COALESCE(portfolio_count, 0) >= ?
        ORDER BY rate DESC, exits_count DESC
        LIMIT 50`,
    )
    .bind(minPortfolio)
    .all<{ id: number; name: string; exits_count: number; portfolio_count: number; rate: number }>();
  return c.json({ items: r.results ?? [], min_portfolio: minPortfolio });
});

// ----------------------------------------------------------- timeline
analyticsFirms.get("/timeline", async (c) => {
  // Firms added per ISO week over last 12 months.
  const r = await c.env.DB
    .prepare(
      `SELECT strftime('%Y-W%W', created_at) AS week, COUNT(*) AS n
         FROM firms
        WHERE created_at >= datetime('now', '-12 months')
        GROUP BY week ORDER BY week`,
    )
    .all<{ week: string; n: number }>();
  return c.json({ points: (r.results ?? []).map((x) => ({ day: x.week, new_firms: x.n })) });
});

// ------------------------------------------------------ coverage gaps
analyticsFirms.get("/coverage-gaps", async (c) => {
  const limit = Math.min(200, Math.max(10, Number(c.req.query("limit") ?? "50")));
  const r = await c.env.DB
    .prepare(
      `SELECT f.id, f.name, f.website, f.domain, f.hq_country_iso2
         FROM firms f
        WHERE (f.website IS NOT NULL AND f.website != '')
          AND NOT EXISTS (SELECT 1 FROM firm_people fp WHERE fp.firm_id = f.id)
        ORDER BY f.last_modified DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all();
  return c.json({ items: r.results ?? [] });
});

// ------------------------------------------------------- sector ROI
async function liveSectorRoi(env: Env) {
  const r = await env.DB.prepare("SELECT sectors_json, check_size_typical_usd FROM firms").all<{ sectors_json: string | null; check_size_typical_usd: number | null }>();
  const e = await env.DB.prepare(
    `SELECT f.sectors_json, AVG(p.exit_value_usd) AS avg_exit
       FROM firm_portfolio p JOIN firms f ON f.id = p.firm_id
       WHERE p.exit_value_usd IS NOT NULL
       GROUP BY f.id`,
  ).all<{ sectors_json: string | null; avg_exit: number }>();
  const checks: Record<string, { sum: number; n: number }> = {};
  for (const row of r.results ?? []) {
    if (row.check_size_typical_usd == null) continue;
    let secs: string[] = [];
    try { if (row.sectors_json) secs = JSON.parse(row.sectors_json); } catch {}
    for (const s of secs) {
      if (typeof s !== "string") continue;
      checks[s] = checks[s] || { sum: 0, n: 0 };
      checks[s].sum += row.check_size_typical_usd;
      checks[s].n += 1;
    }
  }
  const exits: Record<string, { sum: number; n: number }> = {};
  for (const row of e.results ?? []) {
    if (row.avg_exit == null) continue;
    let secs: string[] = [];
    try { if (row.sectors_json) secs = JSON.parse(row.sectors_json); } catch {}
    for (const s of secs) {
      if (typeof s !== "string") continue;
      exits[s] = exits[s] || { sum: 0, n: 0 };
      exits[s].sum += row.avg_exit;
      exits[s].n += 1;
    }
  }
  const items = Object.keys(checks).map((s) => {
    const avgCheck = checks[s].n ? checks[s].sum / checks[s].n : 0;
    const avgExit = exits[s] && exits[s].n ? exits[s].sum / exits[s].n : 0;
    return {
      sector: s,
      avg_check_usd: Math.round(avgCheck),
      avg_exit_usd: Math.round(avgExit),
      roi: avgCheck > 0 ? Number((avgExit / avgCheck).toFixed(2)) : 0,
    };
  }).sort((a, b) => b.roi - a.roi);
  return { items };
}
analyticsFirms.get("/sector-roi", async (c) => {
  const cached = await readMaterialized(c.env, "sector_roi");
  if (cached) return c.json(cached);
  return c.json(await liveSectorRoi(c.env));
});

// Re-export the materializer so the nightly cron can invoke it.
export async function materializeFirmAnalytics(env: Env): Promise<{ wrote: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const items: { kind: string; payload: unknown }[] = [
    { kind: "heatmap", payload: await liveHeatmap(env) },
    { kind: "geo", payload: await liveGeo(env) },
    { kind: "connected", payload: await liveConnected(env, 100) },
    { kind: "sector_roi", payload: await liveSectorRoi(env) },
  ];
  let wrote = 0;
  for (const it of items) {
    try {
      await env.DB
        .prepare(
          `INSERT INTO firm_analytics_daily (snapshot_date, kind, payload_json)
           VALUES (?, ?, ?)
           ON CONFLICT(snapshot_date, kind) DO UPDATE SET payload_json = excluded.payload_json`,
        )
        .bind(day, it.kind, JSON.stringify(it.payload))
        .run();
      wrote += 1;
    } catch (e) {
      console.warn("firm_analytics materialize failed", it.kind, (e as Error).message);
    }
  }
  return { wrote };
}

// Filter parser is exported via _firms_filter.ts; keeping it imported here
// prevents tree-shaking from dropping it when other consumers hold refs.
export { parseFirmFilter, buildFirmWhere };
