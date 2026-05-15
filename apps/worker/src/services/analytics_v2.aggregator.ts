import type { Env } from "../types";
import { computeQuality } from "../scoring/quality";
import { materializeFirmAnalytics } from "../routes/analytics_firms";

function isoDay(d = new Date()): string { return d.toISOString().slice(0, 10); }

/**
 * Nightly aggregator (cron 15 3 * * *). Writes one snapshot row per lead
 * touched in the last 24h, then aggregates source/pipeline KPIs from
 * fetch_log + jobs + provider_usage. Also rolls up dashboard_snapshots so
 * the home page has fast at-a-glance counts.
 */
export async function runNightlyAggregator(env: Env): Promise<{
  leads_snapshotted: number;
  sources_aggregated: number;
  pipeline_day: string;
  firm_analytics_wrote: number;
}> {
  const day = isoDay();
  const since = new Date(Date.now() - 26 * 3600_000).toISOString(); // small overlap
  // ----- 1. Per-lead quality snapshots ------------------------------------
  const touched = await env.DB
    .prepare(
      `SELECT id, name, email, org, title, phone, linkedin_url, country_iso2, city,
              persona_role, seniority, bio, verified, last_enriched_at,
              enrichment_log_json, companies_json, board_seats_json,
              awards_json, exits_json
         FROM leads
        WHERE merged_into IS NULL
          AND (updated_at >= ? OR last_enriched_at >= ? OR id IN
                (SELECT lead_id FROM lead_history WHERE changed_at >= ?))
        LIMIT 5000`,
    )
    .bind(since, since, since)
    .all<Record<string, unknown>>();
  let snapshotted = 0;
  for (const row of touched.results ?? []) {
    const q = computeQuality(row);
    try {
      await env.DB
        .prepare(
          `INSERT INTO lead_quality_snapshots
             (id, lead_id, snapshot_date, score, completeness, verification,
              corroboration, freshness, persona_match, track_record,
              details_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(lead_id, snapshot_date) DO UPDATE SET
             score=excluded.score,
             completeness=excluded.completeness,
             verification=excluded.verification,
             corroboration=excluded.corroboration,
             freshness=excluded.freshness,
             persona_match=excluded.persona_match,
             track_record=excluded.track_record,
             details_json=excluded.details_json`,
        )
        .bind(
          crypto.randomUUID(), row.id, day, q.score,
          q.completeness, q.verification, q.corroboration,
          q.freshness, q.persona_match, q.track_record,
          JSON.stringify(q.details), new Date().toISOString(),
        )
        .run();
      snapshotted += 1;
    } catch (e) {
      console.warn("snapshot failed", row.id, (e as Error).message);
    }
  }

  // ----- 2. Per-source KPIs (yesterday) -----------------------------------
  // We aggregate yesterday so the day is closed; today's row is recomputed
  // on the next run.
  const yday = isoDay(new Date(Date.now() - 24 * 3600_000));
  const dayStart = `${yday}T00:00:00.000Z`;
  const dayEnd = `${yday}T23:59:59.999Z`;
  const sourceRows = await env.DB
    .prepare(
      `SELECT host AS source_domain,
              COUNT(*) AS pages_fetched,
              SUM(CASE WHEN block_reason IS NULL THEN 0 ELSE 1 END) AS pages_blocked,
              SUM(cost_usd) AS cost_usd
         FROM fetch_log
        WHERE created_at >= ? AND created_at <= ?
        GROUP BY host`,
    )
    .bind(dayStart, dayEnd)
    .all<{ source_domain: string; pages_fetched: number; pages_blocked: number; cost_usd: number }>();
  let sourcesAgg = 0;
  for (const s of sourceRows.results ?? []) {
    const leads = await env.DB
      .prepare(
        `SELECT COUNT(*) AS leads_found,
                SUM(CASE WHEN verified=1 THEN 1 ELSE 0 END) AS leads_verified
           FROM leads
          WHERE source_domain = ? AND created_at >= ? AND created_at <= ?
            AND merged_into IS NULL`,
      )
      .bind(s.source_domain, dayStart, dayEnd)
      .first<{ leads_found: number; leads_verified: number }>();
    const avgQ = await env.DB
      .prepare(
        `SELECT AVG(score) AS avg_q FROM lead_quality_snapshots q
            JOIN leads l ON l.id = q.lead_id
           WHERE q.snapshot_date = ? AND l.source_domain = ?`,
      )
      .bind(yday, s.source_domain)
      .first<{ avg_q: number | null }>();
    const lf = leads?.leads_found ?? 0;
    const lv = leads?.leads_verified ?? 0;
    const cost = s.cost_usd ?? 0;
    const cpv = lv > 0 ? cost / lv : 0;
    try {
      await env.DB
        .prepare(
          `INSERT INTO source_kpis_daily
             (id, day, source_domain, pages_fetched, pages_blocked, leads_found,
              leads_verified, cost_usd, avg_quality, cost_per_verified_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, source_domain) DO UPDATE SET
             pages_fetched=excluded.pages_fetched,
             pages_blocked=excluded.pages_blocked,
             leads_found=excluded.leads_found,
             leads_verified=excluded.leads_verified,
             cost_usd=excluded.cost_usd,
             avg_quality=excluded.avg_quality,
             cost_per_verified_usd=excluded.cost_per_verified_usd`,
        )
        .bind(
          crypto.randomUUID(), yday, s.source_domain,
          s.pages_fetched ?? 0, s.pages_blocked ?? 0,
          lf, lv, Number((cost).toFixed(4)),
          Math.round(((avgQ?.avg_q ?? 0) || 0) * 1000) / 1000,
          Number(cpv.toFixed(4)),
          new Date().toISOString(),
        )
        .run();
      sourcesAgg += 1;
    } catch (e) {
      console.warn("source_kpi upsert failed", s.source_domain, (e as Error).message);
    }
  }

  // ----- 3. Pipeline KPIs (yesterday) -------------------------------------
  const statusRows = await env.DB
    .prepare(
      `SELECT status, COUNT(*) AS c FROM leads
        WHERE merged_into IS NULL AND created_at >= ? AND created_at <= ?
        GROUP BY status`,
    )
    .bind(dayStart, dayEnd)
    .all<{ status: string; c: number }>();
  const enrichedRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c FROM leads
        WHERE merged_into IS NULL AND last_enriched_at >= ? AND last_enriched_at <= ?`,
    )
    .bind(dayStart, dayEnd)
    .first<{ c: number }>();
  const verifiedRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c FROM leads
        WHERE merged_into IS NULL AND verified=1 AND created_at >= ? AND created_at <= ?`,
    )
    .bind(dayStart, dayEnd)
    .first<{ c: number }>();
  const jobRows = await env.DB
    .prepare(
      `SELECT status, COUNT(*) AS c FROM jobs
        WHERE started_at >= ? AND started_at <= ? GROUP BY status`,
    )
    .bind(dayStart, dayEnd)
    .all<{ status: string; c: number }>();
  const enrichCost = await env.DB
    .prepare("SELECT SUM(cost_usd) AS s FROM provider_usage WHERE day = ?")
    .bind(yday).first<{ s: number | null }>();
  const scrapeCost = await env.DB
    .prepare("SELECT SUM(cost_usd) AS s FROM fetch_log WHERE created_at >= ? AND created_at <= ?")
    .bind(dayStart, dayEnd).first<{ s: number | null }>();
  const cnt = (rows: { status: string; c: number }[], k: string) =>
    rows.find((r) => r.status === k)?.c ?? 0;
  const sR = statusRows.results ?? [];
  const jR = jobRows.results ?? [];
  await env.DB
    .prepare(
      `INSERT INTO pipeline_kpis_daily
         (id, day, leads_new, leads_enriched, leads_verified, leads_pending,
          leads_approved, leads_contacted, leads_replied, leads_meeting,
          jobs_completed, jobs_failed, enrichment_cost_usd, scraper_cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         leads_new=excluded.leads_new,
         leads_enriched=excluded.leads_enriched,
         leads_verified=excluded.leads_verified,
         leads_pending=excluded.leads_pending,
         leads_approved=excluded.leads_approved,
         leads_contacted=excluded.leads_contacted,
         leads_replied=excluded.leads_replied,
         leads_meeting=excluded.leads_meeting,
         jobs_completed=excluded.jobs_completed,
         jobs_failed=excluded.jobs_failed,
         enrichment_cost_usd=excluded.enrichment_cost_usd,
         scraper_cost_usd=excluded.scraper_cost_usd`,
    )
    .bind(
      crypto.randomUUID(), yday,
      cnt(sR, "new"), enrichedRow?.c ?? 0, verifiedRow?.c ?? 0,
      cnt(sR, "pending"), cnt(sR, "approved"), cnt(sR, "contacted"),
      cnt(sR, "replied"), cnt(sR, "meeting"),
      cnt(jR, "completed"), cnt(jR, "failed"),
      Number((enrichCost?.s ?? 0).toFixed(4)),
      Number((scrapeCost?.s ?? 0).toFixed(4)),
      new Date().toISOString(),
    )
    .run();

  // ----- 4. dashboard_snapshots (today's roll-up) -------------------------
  const tot = await env.DB.prepare("SELECT COUNT(*) AS c FROM leads WHERE merged_into IS NULL").first<{ c: number }>();
  const ver = await env.DB.prepare("SELECT COUNT(*) AS c FROM leads WHERE merged_into IS NULL AND verified=1").first<{ c: number }>();
  const app = await env.DB.prepare("SELECT COUNT(*) AS c FROM leads WHERE merged_into IS NULL AND status='approved'").first<{ c: number }>();
  const pend = await env.DB.prepare("SELECT COUNT(*) AS c FROM leads WHERE merged_into IS NULL AND status='pending'").first<{ c: number }>();
  const act = await env.DB.prepare("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running')").first<{ c: number }>();
  const exp = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM exports WHERE created_at >= ?")
    .bind(`${day}T00:00:00.000Z`).first<{ c: number }>();
  await env.DB
    .prepare(
      `INSERT INTO dashboard_snapshots
         (id, snapshot_date, total_leads, verified_leads, approved_leads,
          pending_leads, active_jobs, exports_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(), day,
      tot?.c ?? 0, ver?.c ?? 0, app?.c ?? 0, pend?.c ?? 0,
      act?.c ?? 0, exp?.c ?? 0, new Date().toISOString(),
    )
    .run();

  // ----- 5. firm_analytics_daily (Task #20) -------------------------------
  // Heatmap, geo, sector ROI, and connectedness ranks materialize so the
  // analytics-firms page loads under 500ms. Failures are non-fatal.
  let firmAnalyticsWrote = 0;
  try {
    const out = await materializeFirmAnalytics(env);
    firmAnalyticsWrote = out.wrote;
  } catch (e) {
    console.warn("firm_analytics aggregator failed", (e as Error).message);
  }

  return {
    leads_snapshotted: snapshotted,
    sources_aggregated: sourcesAgg,
    pipeline_day: yday,
    firm_analytics_wrote: firmAnalyticsWrote,
  };
}
