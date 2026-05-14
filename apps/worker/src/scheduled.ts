import type { Env, JobMessage } from "./types";
import { enrichLead } from "./enrichment/orchestrator";
import { runNightlyAggregator } from "./services/analytics_v2.aggregator";

interface SourceRow {
  id: string;
  domain: string;
}

interface LeadRow {
  id: string;
  priority: string | null;
  last_enriched_at: string | null;
}

/**
 * Cron handler: enqueue a re-scrape for every enabled source whose
 * last_scraped_at is null or older than 24h, then re-enrich stale leads
 * (>30d, or p0/p1 >7d, capped at 500/run). Called every 6h via wrangler.toml.
 */
export async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // Cron 15 3 * * * → nightly analytics aggregator. The cron string itself
  // is matched in wrangler.toml; here we route by the scheduled-event cron.
  if (event && (event as ScheduledEvent).cron === "15 3 * * *") {
    ctx.waitUntil(
      runNightlyAggregator(env).catch((e) => console.error("nightly aggregator failed", (e as Error).message)),
    );
    return;
  }
  const r = await env.DB.prepare(
    `SELECT id, domain FROM sources
       WHERE enabled = 1
         AND (last_scraped_at IS NULL OR datetime(last_scraped_at) < datetime('now','-24 hours'))
       LIMIT 200`,
  ).all<SourceRow>();
  const rows = r.results ?? [];

  const enqueueScrapes = async () => {
    for (const row of rows) {
      const target = `https://${row.domain}/`;
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();
      try {
        await env.DB.prepare(
          `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
           VALUES (?, ?, ?, 'queued', 'url', ?, ?, ?, ?)`,
        )
          .bind(jobId, `cron:${row.domain}`, row.domain, target, JSON.stringify({ trigger: "scheduled" }), now, now)
          .run();
        const msg: JobMessage = { jobId, kind: "url", target };
        await env.LEAD_QUEUE.send(msg);
      } catch (e) {
        console.warn("scheduled enqueue failed", row.domain, (e as Error).message);
      }
    }
  };

  const reEnrichStale = async () => {
    // p0/p1: re-enrich after 7d. Everything else: 30d. Cap at 500.
    const stale = await env.DB
      .prepare(
        `SELECT id, priority, last_enriched_at FROM leads
           WHERE merged_into IS NULL
             AND (
               (priority IN ('p0','p1') AND (last_enriched_at IS NULL OR datetime(last_enriched_at) < datetime('now','-7 days')))
               OR
               (last_enriched_at IS NULL OR datetime(last_enriched_at) < datetime('now','-30 days'))
             )
           ORDER BY (last_enriched_at IS NULL) DESC, last_enriched_at ASC
           LIMIT 500`,
      )
      .all<LeadRow>();
    for (const lead of stale.results ?? []) {
      try {
        await enrichLead(env, lead.id);
      } catch (e) {
        console.warn("scheduled enrich failed", lead.id, (e as Error).message);
      }
    }
  };

  ctx.waitUntil(enqueueScrapes());
  ctx.waitUntil(reEnrichStale());
}
