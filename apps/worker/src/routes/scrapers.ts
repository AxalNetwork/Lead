import { Hono } from "hono";
import type { Env } from "../types";
import { listBlockedDomains } from "../scraper/tos";
import { todayUsage } from "../enrichment/budget";
import { ALL_PROVIDERS } from "../enrichment/providers";
import { getBurn } from "../ai/budget";

export const scrapers = new Hono<{ Bindings: Env; Variables: { email: string } }>();

interface FetchLogRow {
  host: string;
  tier: number;
  status: number;
  bytes: number;
  block_reason: string | null;
  duration_ms: number;
  cost_usd: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

scrapers.get("/health", async (c) => {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT host, tier, status, bytes, block_reason, duration_ms, cost_usd
       FROM fetch_log
      WHERE created_at >= ?
      ORDER BY host`,
  )
    .bind(since)
    .all<FetchLogRow>();

  const byHost = new Map<
    string,
    {
      total: number;
      blocked: number;
      durations: number[];
      cost: number;
      bytes: number;
      tiers: Record<number, number>;
      blockReasons: Record<string, number>;
    }
  >();

  for (const r of rows.results ?? []) {
    let agg = byHost.get(r.host);
    if (!agg) {
      agg = { total: 0, blocked: 0, durations: [], cost: 0, bytes: 0, tiers: {}, blockReasons: {} };
      byHost.set(r.host, agg);
    }
    agg.total += 1;
    if (r.block_reason) {
      agg.blocked += 1;
      const key = r.block_reason.split(":")[0];
      agg.blockReasons[key] = (agg.blockReasons[key] ?? 0) + 1;
    }
    agg.durations.push(r.duration_ms);
    agg.cost += r.cost_usd;
    agg.bytes += r.bytes;
    agg.tiers[r.tier] = (agg.tiers[r.tier] ?? 0) + 1;
  }

  const hosts = [...byHost.entries()]
    .map(([host, a]) => {
      const sorted = a.durations.slice().sort((x, y) => x - y);
      return {
        host,
        total: a.total,
        blocked: a.blocked,
        block_rate: a.total ? Number((a.blocked / a.total).toFixed(3)) : 0,
        p50_ms: percentile(sorted, 50),
        p95_ms: percentile(sorted, 95),
        cost_usd: Number(a.cost.toFixed(4)),
        bytes: a.bytes,
        tier_mix: a.tiers,
        block_reasons: a.blockReasons,
      };
    })
    .sort((a, b) => b.total - a.total);

  // Provider budget pressure: today's spend, blocked-call counters, and which
  // providers are currently capped out.
  const usage = await todayUsage(c.env.DB);
  const usageByName = new Map(usage.map((u) => [u.provider, u]));
  const providers = ALL_PROVIDERS.map((p) => {
    const u = usageByName.get(p.name);
    const cap = p.dailyCapUsd(c.env);
    const spent = u?.cost_usd ?? 0;
    return {
      name: p.name,
      configured: p.isConfigured(c.env),
      is_free: p.isFree === true,
      daily_cap_usd: p.isFree ? null : cap,
      spent_today_usd: Number(spent.toFixed(4)),
      calls_today: u?.calls ?? 0,
      blocked_today: u?.blocked_calls ?? 0,
      last_block_reason: u?.last_block_reason ?? null,
      budget_exhausted: cap > 0 && spent >= cap,
      disabled: cap === 0,
    };
  });

  // Task #25: AI / Vectorize daily budget burn-down so the dashboard can
  // surface how much of today's neuron + vector-query allowance has been
  // spent. Falls back gracefully when the ai_cost_daily table is empty.
  const aiBudget = await getBurn(c.env).catch(() => null);

  return c.json({
    window_hours: 24,
    generated_at: new Date().toISOString(),
    hosts,
    blocked_domains: listBlockedDomains(),
    providers,
    ai_budget: aiBudget,
  });
});
