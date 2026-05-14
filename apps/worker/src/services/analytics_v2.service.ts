import type { Env } from "../types";
import { computeQuality } from "../scoring/quality";
import { FUNNEL_STATUSES } from "../scoring/config";
import { ALL_PROVIDERS } from "../enrichment/providers";

interface CountRow { c: number }

function isoDay(d: Date): string { return d.toISOString().slice(0, 10); }
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

export class AnalyticsV2Service {
  constructor(private env: Env) {}
  private get db(): D1Database { return this.env.DB; }

  // ---- /trends/leads -------------------------------------------------------
  async trendLeads(days: number) {
    const since = daysAgoIso(days);
    const r = await this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS new_leads
           FROM leads
          WHERE created_at >= ? AND merged_into IS NULL
          GROUP BY day ORDER BY day`,
      )
      .bind(since)
      .all<{ day: string; new_leads: number }>();
    const v = await this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                SUM(CASE WHEN verified=1 THEN 1 ELSE 0 END) AS verified
           FROM leads
          WHERE created_at >= ? AND merged_into IS NULL
          GROUP BY day ORDER BY day`,
      )
      .bind(since)
      .all<{ day: string; verified: number }>();
    const map = new Map<string, { day: string; new_leads: number; verified: number }>();
    for (const row of r.results ?? []) map.set(row.day, { day: row.day, new_leads: row.new_leads, verified: 0 });
    for (const row of v.results ?? []) {
      const cur = map.get(row.day) ?? { day: row.day, new_leads: 0, verified: 0 };
      cur.verified = row.verified;
      map.set(row.day, cur);
    }
    // Backfill missing days with zeros so the chart has a continuous x-axis.
    const out: Array<{ day: string; new_leads: number; verified: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = isoDay(new Date(Date.now() - i * 86400_000));
      out.push(map.get(d) ?? { day: d, new_leads: 0, verified: 0 });
    }
    return out;
  }

  // ---- /leads/quality ------------------------------------------------------
  async leadsQuality(days: number) {
    // Pull the latest snapshot per lead within the window. If no snapshot,
    // fall back to computing live from the lead row (cheap for ≤ 500 leads).
    const since = daysAgoIso(days);
    const snaps = await this.db
      .prepare(
        `SELECT lead_id, score, completeness, verification, corroboration,
                freshness, persona_match, track_record, snapshot_date
           FROM lead_quality_snapshots
          WHERE snapshot_date >= ?
          ORDER BY snapshot_date DESC`,
      )
      .bind(since.slice(0, 10))
      .all<{
        lead_id: string; score: number;
        completeness: number; verification: number; corroboration: number;
        freshness: number; persona_match: number; track_record: number;
        snapshot_date: string;
      }>();
    const latest = new Map<string, typeof snaps.results[number]>();
    for (const s of snaps.results ?? []) if (!latest.has(s.lead_id)) latest.set(s.lead_id, s);

    const tot = await this.db
      .prepare("SELECT COUNT(*) AS c FROM leads WHERE merged_into IS NULL")
      .first<CountRow>();
    const totalLeads = tot?.c ?? 0;
    const buckets = { p0_25: 0, p25_50: 0, p50_75: 0, p75_100: 0 };
    let sum = 0; let sumComp = 0; let sumVer = 0; let sumCorr = 0;
    let sumFresh = 0; let sumPers = 0; let sumTrack = 0; let n = 0;
    for (const s of latest.values()) {
      n += 1;
      sum += s.score;
      sumComp += s.completeness; sumVer += s.verification; sumCorr += s.corroboration;
      sumFresh += s.freshness; sumPers += s.persona_match; sumTrack += s.track_record;
      const pct = s.score * 100;
      if (pct < 25) buckets.p0_25 += 1;
      else if (pct < 50) buckets.p25_50 += 1;
      else if (pct < 75) buckets.p50_75 += 1;
      else buckets.p75_100 += 1;
    }
    return {
      window_days: days,
      total_leads: totalLeads,
      scored_leads: n,
      avg_score: n ? Math.round((sum / n) * 1000) / 1000 : 0,
      avg_breakdown: n ? {
        completeness: Math.round((sumComp / n) * 1000) / 1000,
        verification: Math.round((sumVer / n) * 1000) / 1000,
        corroboration: Math.round((sumCorr / n) * 1000) / 1000,
        freshness: Math.round((sumFresh / n) * 1000) / 1000,
        persona_match: Math.round((sumPers / n) * 1000) / 1000,
        track_record: Math.round((sumTrack / n) * 1000) / 1000,
      } : null,
      buckets,
    };
  }

  // ---- /leads/funnel -------------------------------------------------------
  async leadsFunnel() {
    // We compute the funnel from the lead row directly: each stage is a
    // monotonic predicate so the count is well-defined.
    const stages: Array<{ status: string; count: number }> = [];
    for (const status of FUNNEL_STATUSES) {
      let where: string;
      if (status === "new") where = "status='new'";
      else if (status === "enriched") where = "last_enriched_at IS NOT NULL";
      else if (status === "verified") where = "verified=1";
      else where = "status=?";
      const stmt = where.includes("?")
        ? this.db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE merged_into IS NULL AND ${where}`).bind(status)
        : this.db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE merged_into IS NULL AND ${where}`);
      const r = await stmt.first<CountRow>();
      stages.push({ status, count: r?.c ?? 0 });
    }
    return { stages, generated_at: new Date().toISOString() };
  }

  // ---- /leads/segments ----------------------------------------------------
  async leadsSegments() {
    // Heatmap of country × sector_focus. sector_focus is a JSON array; we
    // just count leads whose sector_focus_json contains a token. Cheap join
    // via SQL: pull rows and aggregate in JS (segment lists are small).
    const rows = await this.db
      .prepare(
        `SELECT country_iso2 AS country, sector_focus_json
           FROM leads
          WHERE merged_into IS NULL`,
      )
      .all<{ country: string | null; sector_focus_json: string | null }>();
    const cell = new Map<string, number>();   // key = `${country}|${sector}`
    const countries = new Map<string, number>();
    const sectors = new Map<string, number>();
    for (const r of rows.results ?? []) {
      const country = r.country || "—";
      let sec: string[] = [];
      if (r.sector_focus_json) {
        try {
          const v = JSON.parse(r.sector_focus_json);
          if (Array.isArray(v)) sec = v.filter((x) => typeof x === "string");
        } catch { /* ignore malformed */ }
      }
      if (!sec.length) sec = ["—"];
      countries.set(country, (countries.get(country) ?? 0) + 1);
      for (const s of sec) {
        sectors.set(s, (sectors.get(s) ?? 0) + 1);
        const k = `${country}|${s}`;
        cell.set(k, (cell.get(k) ?? 0) + 1);
      }
    }
    const sortedCountries = [...countries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x[0]);
    const sortedSectors = [...sectors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x[0]);
    const matrix = sortedCountries.map((c) =>
      sortedSectors.map((s) => cell.get(`${c}|${s}`) ?? 0),
    );
    return { countries: sortedCountries, sectors: sortedSectors, matrix };
  }

  // ---- /leads/value -------------------------------------------------------
  async leadsValue() {
    // Addressable value = sum of (aum_usd + fund_size_usd + last_round_usd)
    // grouped by status bucket.
    const rows = await this.db
      .prepare(
        `SELECT status,
                COUNT(*) AS lead_count,
                COALESCE(SUM(COALESCE(aum_usd,0) + COALESCE(fund_size_usd,0) + COALESCE(last_round_usd,0)), 0) AS value_usd
           FROM leads
          WHERE merged_into IS NULL
          GROUP BY status
          ORDER BY value_usd DESC`,
      )
      .all<{ status: string; lead_count: number; value_usd: number }>();
    const items = rows.results ?? [];
    const total = items.reduce((s, r) => s + (r.value_usd ?? 0), 0);
    return { total_value_usd: total, by_status: items };
  }

  // ---- /jobs/perf ---------------------------------------------------------
  async jobsPerf(days: number) {
    const since = daysAgoIso(days);
    const r = await this.db
      .prepare(
        `SELECT substr(started_at,1,10) AS day, status, COUNT(*) AS c
           FROM jobs
          WHERE started_at >= ?
          GROUP BY day, status
          ORDER BY day`,
      )
      .bind(since)
      .all<{ day: string; status: string; c: number }>();
    const map = new Map<string, { day: string; completed: number; failed: number; running: number; queued: number }>();
    for (const row of r.results ?? []) {
      const cur = map.get(row.day) ?? { day: row.day, completed: 0, failed: 0, running: 0, queued: 0 };
      if (row.status === "completed") cur.completed = row.c;
      else if (row.status === "failed") cur.failed = row.c;
      else if (row.status === "running") cur.running = row.c;
      else if (row.status === "queued") cur.queued = row.c;
      map.set(row.day, cur);
    }
    // Average duration in seconds for completed jobs.
    const dur = await this.db
      .prepare(
        `SELECT AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS avg_seconds,
                COUNT(*) AS n
           FROM jobs
          WHERE finished_at IS NOT NULL AND started_at >= ? AND status='completed'`,
      )
      .bind(since)
      .first<{ avg_seconds: number | null; n: number }>();
    return {
      window_days: days,
      points: [...map.values()].sort((a, b) => a.day.localeCompare(b.day)),
      avg_completed_seconds: dur?.avg_seconds ? Math.round(dur.avg_seconds) : null,
      completed_jobs: dur?.n ?? 0,
    };
  }

  // ---- /scrapers/cost -----------------------------------------------------
  async scrapersCost(days: number) {
    const since = daysAgoIso(days);
    const fl = await this.db
      .prepare(
        `SELECT substr(created_at,1,10) AS day,
                SUM(cost_usd) AS scraper_cost,
                SUM(CASE WHEN block_reason IS NULL THEN 0 ELSE 1 END) AS blocked,
                COUNT(*) AS attempts
           FROM fetch_log
          WHERE created_at >= ?
          GROUP BY day ORDER BY day`,
      )
      .bind(since)
      .all<{ day: string; scraper_cost: number; blocked: number; attempts: number }>();
    const pu = await this.db
      .prepare(
        `SELECT day, SUM(cost_usd) AS provider_cost
           FROM provider_usage
          WHERE day >= ?
          GROUP BY day ORDER BY day`,
      )
      .bind(since.slice(0, 10))
      .all<{ day: string; provider_cost: number }>();
    const map = new Map<string, { day: string; scraper_cost: number; provider_cost: number; blocked: number; attempts: number }>();
    for (const r of fl.results ?? []) {
      map.set(r.day, { day: r.day, scraper_cost: r.scraper_cost ?? 0, provider_cost: 0, blocked: r.blocked ?? 0, attempts: r.attempts ?? 0 });
    }
    for (const r of pu.results ?? []) {
      const cur = map.get(r.day) ?? { day: r.day, scraper_cost: 0, provider_cost: 0, blocked: 0, attempts: 0 };
      cur.provider_cost = r.provider_cost ?? 0;
      map.set(r.day, cur);
    }
    const points = [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
    // Per-provider rollup over the window.
    const providers = await this.db
      .prepare(
        `SELECT provider, SUM(cost_usd) AS cost_usd, SUM(calls) AS calls, SUM(blocked_calls) AS blocked
           FROM provider_usage
          WHERE day >= ?
          GROUP BY provider ORDER BY cost_usd DESC`,
      )
      .bind(since.slice(0, 10))
      .all<{ provider: string; cost_usd: number; calls: number; blocked: number }>();
    return { window_days: days, points, providers: providers.results ?? [] };
  }

  // ---- /scrapers/health (alias of /api/scrapers/health, kept under analytics) -----
  async scrapersHealth() {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const rows = await this.db
      .prepare(
        `SELECT host, COUNT(*) AS attempts,
                SUM(CASE WHEN block_reason IS NULL THEN 0 ELSE 1 END) AS blocked,
                SUM(cost_usd) AS cost,
                AVG(duration_ms) AS avg_ms
           FROM fetch_log
          WHERE created_at >= ?
          GROUP BY host ORDER BY attempts DESC LIMIT 30`,
      )
      .bind(since)
      .all<{ host: string; attempts: number; blocked: number; cost: number; avg_ms: number }>();
    // Tier-mix sparkline: hourly counts of tier 0..5 over last 24h.
    const mix = await this.db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H', created_at) AS hour, tier, COUNT(*) AS c
           FROM fetch_log
          WHERE created_at >= ?
          GROUP BY hour, tier ORDER BY hour`,
      )
      .bind(since)
      .all<{ hour: string; tier: number; c: number }>();
    const sparkline: Record<string, number[]> = {}; // tier → 24-bucket counts
    const hours: string[] = [];
    for (let i = 23; i >= 0; i--) hours.push(new Date(Date.now() - i * 3600_000).toISOString().slice(0, 13));
    for (const row of mix.results ?? []) {
      const idx = hours.indexOf(row.hour);
      if (idx < 0) continue;
      const key = String(row.tier);
      if (!sparkline[key]) sparkline[key] = new Array(24).fill(0);
      sparkline[key][idx] = row.c;
    }
    // Provider summary (configured / disabled).
    const providers = ALL_PROVIDERS.map((p) => ({
      name: p.name,
      configured: p.isConfigured(this.env),
      cap_usd: p.dailyCapUsd(this.env),
    }));
    return {
      window_hours: 24,
      hosts: (rows.results ?? []).map((r) => ({
        host: r.host, attempts: r.attempts, blocked: r.blocked,
        block_rate: r.attempts ? Number((r.blocked / r.attempts).toFixed(3)) : 0,
        cost_usd: Number((r.cost ?? 0).toFixed(4)),
        avg_ms: Math.round(r.avg_ms ?? 0),
      })),
      sparkline,
      providers,
    };
  }
}

// Pure helper exported for the nightly cron.
export { computeQuality };
