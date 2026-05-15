// Analytics Engine-backed analytics endpoints (Task #25 step 7).
//
// Reads the D1 ai_cost_daily roll-up populated by analytics/events.ts.
// When the GraphQL Analytics Engine API token is configured we could
// upgrade this to query AE directly; for now D1 gives us the same data
// with simpler auth.

import { Hono } from "hono";
import type { Env } from "../types";

export const aiAnalytics = new Hono<{ Bindings: Env; Variables: { email: string } }>();

aiAnalytics.get("/ai-cost", async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30)));
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const r = await c.env.DB.prepare(
    `SELECT day, purpose, model, neurons, cost_usd, calls
       FROM ai_cost_daily
      WHERE day >= ?
      ORDER BY day DESC, purpose ASC`,
  ).bind(since).all<{ day: string; purpose: string; model: string; neurons: number; cost_usd: number; calls: number }>();
  const rows = r.results ?? [];
  const byDay: Record<string, Record<string, number>> = {};
  let totalCost = 0, totalNeurons = 0, totalCalls = 0;
  for (const row of rows) {
    byDay[row.day] ??= {};
    byDay[row.day][row.purpose] = (byDay[row.day][row.purpose] ?? 0) + Number(row.cost_usd);
    totalCost += Number(row.cost_usd);
    totalNeurons += Number(row.neurons);
    totalCalls += Number(row.calls);
  }
  return c.json({
    days,
    rows,
    by_day: byDay,
    totals: { cost_usd: totalCost, neurons: totalNeurons, calls: totalCalls },
  });
});
