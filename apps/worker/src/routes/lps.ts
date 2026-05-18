// Task #2: LP-disclosure API routes.
//
// Three pivots over `lp_fund_commitments`:
//   GET /api/lps/:entity_id/commitments?as_of=    — one LP's commitments
//   GET /api/funds/:fund_id/known-lps             — one fund's LP roster
//   GET /api/firms/:firm_id/lp-mix                — donut by LP class
//
// All routes require accessGuard (mounted in src/index.ts under
// /api/*). The data table is platform-global (no owner isolation), so
// the only auth check is the existing email allowlist.

import { Hono } from "hono";
import type { Env } from "../types";

type Vars = { email: string; is_admin: boolean };

export const lpsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const fundsLpRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const firmsLpRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

interface CommitmentRow {
  id: string;
  lp_entity_id: string;
  fund_entity_id: string | null;
  fund_name_raw: string;
  gp_firm_entity_id: string | null;
  vintage_year: number | null;
  committed_usd: number | null;
  called_usd: number | null;
  distributed_usd: number | null;
  nav_usd: number | null;
  net_irr_pct: number | null;
  tvpi: number | null;
  dpi: number | null;
  as_of_date: string;
  source_id: string | null;
  source_url: string | null;
  source_filing_date: string | null;
  confidence: number;
}

function clampLimit(raw: string | undefined, def = 100, max = 500): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.trunc(n), max);
}

// ---------------- /api/lps/:entity_id/commitments ----------------
lpsRoute.get("/:entity_id/commitments", async (c) => {
  const lp = c.req.param("entity_id");
  const as_of = c.req.query("as_of");
  const limit = clampLimit(c.req.query("limit"));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const where: string[] = ["lp_entity_id = ?"];
  const binds: unknown[] = [lp];
  if (as_of) { where.push("as_of_date = ?"); binds.push(as_of); }
  const sql = `
    SELECT id, lp_entity_id, fund_entity_id, fund_name_raw, gp_firm_entity_id,
           vintage_year, committed_usd, called_usd, distributed_usd, nav_usd,
           net_irr_pct, tvpi, dpi, as_of_date,
           source_id, source_url, source_filing_date, confidence
      FROM lp_fund_commitments
     WHERE ${where.join(" AND ")}
     ORDER BY as_of_date DESC, (committed_usd IS NULL), committed_usd DESC
     LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql).bind(...binds, limit, offset).all<CommitmentRow>();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lp_fund_commitments WHERE ${where.join(" AND ")}`,
  ).bind(...binds).first<{ n: number }>();
  return c.json({
    lp_entity_id: lp,
    as_of: as_of ?? null,
    total: total?.n ?? 0,
    limit, offset,
    commitments: rows.results ?? [],
  });
});

// ---------------- /api/funds/:fund_id/known-lps ----------------
fundsLpRoute.get("/:fund_id/known-lps", async (c) => {
  const fund = c.req.param("fund_id");
  // Per LP, take metrics from the row with the maximum as_of_date —
  // NOT MAX(metric), which would mix periods. We resolve "latest row"
  // via a correlated subquery on the same (fund_entity_id,
  // lp_entity_id) pair.
  const rows = await c.env.DB.prepare(
    `SELECT lp.lp_entity_id,
            e.display_name      AS lp_display_name,
            (SELECT value_text FROM facts
              WHERE entity_id = lp.lp_entity_id AND predicate = 'lp.class' AND is_current = 1
              LIMIT 1)          AS lp_class,
            lp.as_of_date       AS latest_as_of,
            lp.committed_usd    AS latest_committed_usd,
            lp.nav_usd          AS latest_nav_usd,
            lp.net_irr_pct      AS latest_net_irr_pct,
            (SELECT COUNT(*) FROM lp_fund_commitments x
              WHERE x.fund_entity_id = lp.fund_entity_id
                AND x.lp_entity_id   = lp.lp_entity_id) AS report_count
       FROM lp_fund_commitments lp
       JOIN u_entities e ON e.id = lp.lp_entity_id
      WHERE lp.fund_entity_id = ?
        AND lp.as_of_date = (
          SELECT MAX(x.as_of_date) FROM lp_fund_commitments x
           WHERE x.fund_entity_id = lp.fund_entity_id
             AND x.lp_entity_id   = lp.lp_entity_id
        )
      ORDER BY (lp.committed_usd IS NULL), lp.committed_usd DESC
      LIMIT 500`,
  ).bind(fund).all<{
    lp_entity_id: string; lp_display_name: string | null; lp_class: string | null;
    latest_as_of: string; latest_committed_usd: number | null; latest_nav_usd: number | null;
    latest_net_irr_pct: number | null; report_count: number;
  }>();
  return c.json({
    fund_entity_id: fund,
    lp_count: rows.results?.length ?? 0,
    lps: rows.results ?? [],
  });
});

// ---------------- /api/firms/:firm_id/lp-mix ----------------
firmsLpRoute.get("/:firm_id/lp-mix", async (c) => {
  const firm = c.req.param("firm_id");
  // Aggregate by lp_class. To avoid double-counting the same LP/fund
  // across reporting periods, take only the LATEST row per
  // (gp_firm_entity_id, lp_entity_id, fund_name_raw) before summing.
  // Class is read from the lp.class fact, falling back to 'other'
  // when the LP entity hasn't been tagged.
  const rows = await c.env.DB.prepare(
    `WITH latest AS (
       SELECT lp.lp_entity_id, lp.fund_name_raw, lp.committed_usd
         FROM lp_fund_commitments lp
        WHERE lp.gp_firm_entity_id = ?
          AND lp.as_of_date = (
            SELECT MAX(x.as_of_date) FROM lp_fund_commitments x
             WHERE x.gp_firm_entity_id = lp.gp_firm_entity_id
               AND x.lp_entity_id      = lp.lp_entity_id
               AND x.fund_name_raw     = lp.fund_name_raw
          )
     ),
     cmt AS (
       SELECT lp_entity_id,
              SUM(COALESCE(committed_usd, 0)) AS committed_sum
         FROM latest
        GROUP BY lp_entity_id
     )
     SELECT COALESCE(
              (SELECT value_text FROM facts
                WHERE entity_id = cmt.lp_entity_id
                  AND predicate = 'lp.class' AND is_current = 1
                LIMIT 1),
              'other'
            ) AS lp_class,
            COUNT(*)                AS lp_count,
            SUM(cmt.committed_sum)  AS committed_usd
       FROM cmt
      GROUP BY lp_class
      ORDER BY (committed_usd IS NULL), committed_usd DESC`,
  ).bind(firm).all<{ lp_class: string; lp_count: number; committed_usd: number | null }>();
  const buckets = rows.results ?? [];
  const total = buckets.reduce((sum, b) => sum + (b.committed_usd ?? 0), 0);
  const total_lps = buckets.reduce((sum, b) => sum + b.lp_count, 0);
  return c.json({
    firm_entity_id: firm,
    total_committed_usd: total,
    total_lp_count: total_lps,
    mix: buckets.map((b) => ({
      lp_class: b.lp_class,
      lp_count: b.lp_count,
      committed_usd: b.committed_usd ?? 0,
      share_pct: total > 0 ? Math.round(((b.committed_usd ?? 0) / total) * 1000) / 10 : 0,
    })),
  });
});
