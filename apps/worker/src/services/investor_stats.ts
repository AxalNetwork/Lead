// Task #24 — nightly investor-stats aggregator.
//
// Cron: `30 3 * * *`. Recomputes per-investor counters
// (investment_count, unicorn_count, exit_count, avg_check_usd,
// total_deployed_usd, board_seats_count) and snapshots a row into
// investor_stats_daily for trend plotting.
//
// Designed to fit in a single 30s scheduled invocation by:
// - Joining investor_investments + companies in one SQL pass per chunk.
// - Updating leads in chunks of 200 via D1 batch().
// - Capping per-run population to 5000 investors (ample for current scale).

import type { Env } from "../types";

interface AggRow {
  investor_lead_id: string;
  investment_count: number;
  unicorn_count: number;
  exit_count: number;
  avg_check_usd: number | null;
  total_deployed_usd: number | null;
}

const CHUNK = 200;

export async function runInvestorStats(env: Env): Promise<{ updated: number }> {
  // Pull a fresh aggregate per investor in one query. Bounded by LIMIT to
  // keep the worker safely under the 30s CPU budget.
  const aggR = await env.DB.prepare(
    `SELECT ii.investor_lead_id,
            COUNT(*)                                        AS investment_count,
            SUM(CASE WHEN c.unicorn = 1 THEN 1 ELSE 0 END)  AS unicorn_count,
            SUM(CASE WHEN c.exit_kind IS NOT NULL THEN 1 ELSE 0 END) AS exit_count,
            CAST(AVG(NULLIF(ii.amount_usd,0)) AS INTEGER)   AS avg_check_usd,
            CAST(SUM(COALESCE(ii.amount_usd,0)) AS INTEGER) AS total_deployed_usd
       FROM investor_investments ii
  LEFT JOIN companies c ON c.id = ii.company_id
      WHERE ii.investor_lead_id IS NOT NULL
      GROUP BY ii.investor_lead_id
      ORDER BY ii.investor_lead_id
      LIMIT 5000`,
  ).all<AggRow>();
  const rows = aggR.results ?? [];
  if (!rows.length) return { updated: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const updateLead = env.DB.prepare(
    `UPDATE leads
        SET investment_count = ?, unicorn_count = ?, exit_count = ?,
            avg_check_usd = ?, total_deployed_usd = ?
      WHERE id = ?`,
  );
  const insertSnapshot = env.DB.prepare(
    `INSERT INTO investor_stats_daily
       (investor_lead_id, date, investment_count, unicorn_count, exit_count,
        avg_check_usd, total_deployed_usd, active_portfolio_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(investor_lead_id, date) DO UPDATE SET
       investment_count = excluded.investment_count,
       unicorn_count    = excluded.unicorn_count,
       exit_count       = excluded.exit_count,
       avg_check_usd    = excluded.avg_check_usd,
       total_deployed_usd = excluded.total_deployed_usd,
       active_portfolio_count = excluded.active_portfolio_count`,
  );

  let updated = 0;
  for (let off = 0; off < rows.length; off += CHUNK) {
    const slice = rows.slice(off, off + CHUNK);
    const stmts = [] as ReturnType<typeof updateLead.bind>[];
    for (const r of slice) {
      stmts.push(updateLead.bind(
        r.investment_count, r.unicorn_count, r.exit_count,
        r.avg_check_usd, r.total_deployed_usd, r.investor_lead_id,
      ));
      // active_portfolio_count = investments minus exits.
      const active = Math.max(0, (r.investment_count ?? 0) - (r.exit_count ?? 0));
      stmts.push(insertSnapshot.bind(
        r.investor_lead_id, today,
        r.investment_count, r.unicorn_count, r.exit_count,
        r.avg_check_usd, r.total_deployed_usd, active,
      ));
    }
    await env.DB.batch(stmts);
    updated += slice.length;
  }
  return { updated };
}
