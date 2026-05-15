import type { Env, JobMessage } from "./types";
import { enrichLead } from "./enrichment/orchestrator";
import { runNightlyAggregator } from "./services/analytics_v2.aggregator";
import { runRelationshipDerivation } from "./scraper/relationships/derive";
import { runInvestorStats } from "./services/investor_stats";
import { recomputeAccountScore } from "./prospects/repo";
import { ensureRoleTaxonomySeeded } from "./prospects/seedRoles";

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
  // Cron 45 3 * * * → nightly relationship derivation. Runs after the
  // analytics aggregator so any new entities created today are picked up.
  if (event && (event as ScheduledEvent).cron === "45 3 * * *") {
    ctx.waitUntil(
      runRelationshipDerivation(env)
        .then((r) => console.log("relationship derivation done", JSON.stringify(r)))
        .catch((e) => console.error("relationship derivation failed", (e as Error).message)),
    );
    return;
  }
  // Cron 20 3 * * * → Task #44 nightly account-score refresh. Re-decays
  // intent for stale rows (score_recomputed_at NULL or > 24h old) and
  // ensures the role_taxonomy seed has been applied at least once.
  if (event && (event as ScheduledEvent).cron === "20 3 * * *") {
    ctx.waitUntil((async () => {
      try {
        await ensureRoleTaxonomySeeded(env);
        const r = await env.DB.prepare(
          `SELECT id FROM accounts
            WHERE status NOT IN ('lost','disqualified')
              AND (score_recomputed_at IS NULL OR datetime(score_recomputed_at) < datetime('now','-1 day'))
            ORDER BY score_recomputed_at IS NULL DESC, score_recomputed_at ASC
            LIMIT 1000`,
        ).all<{ id: string }>();
        let n = 0;
        for (const row of r.results ?? []) {
          try { await recomputeAccountScore(env, row.id); n += 1; } catch (e) { console.warn("nightly account score failed", row.id, (e as Error).message); }
        }
        console.log("nightly account scores done", n);
      } catch (e) {
        console.error("nightly account scores failed", (e as Error).message);
      }
    })());
    return;
  }
  // Cron 30 3 * * * → recompute investor counters + snapshot daily stats
  // (Task #24). Runs between the analytics aggregator (15) and relationship
  // derivation (45) so today's snapshot is fresh when downstream jobs read.
  if (event && (event as ScheduledEvent).cron === "30 3 * * *") {
    ctx.waitUntil(
      runInvestorStats(env)
        .then((r) => console.log("investor stats done", JSON.stringify(r)))
        .catch((e) => console.error("investor stats failed", (e as Error).message)),
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
