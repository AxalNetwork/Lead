import type { Env, JobMessage } from "./types";
import { enrichLead } from "./enrichment/orchestrator";
import { runNightlyAggregator } from "./services/analytics_v2.aggregator";
import { runRelationshipDerivation } from "./scraper/relationships/derive";
import { runInvestorStats } from "./services/investor_stats";
import { recomputeAccountScore } from "./prospects/repo";
import { ensureRoleTaxonomySeeded } from "./prospects/seedRoles";
// Task #5: source registry — drives the 6h cron + nightly staleness sweep.
import { enqueueSourceRun, sweepStaleEntities, type SourceRow } from "./sources/registry";
import { loadSeedSources } from "./sources/seed_loader";
// Task #2: periodic stuck-job sweeper. Guarantees timeout convergence
// even when queue traffic is too low to trigger the batch-head sweep.
import { sweepStuckJobs } from "./routes/admin";

interface LegacySourceRow {
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
  // Cron 0 * * * * → Task #45 hourly buyer-signal crawl. Dispatches the
  // CrawlSignalsWorkflow when bound; otherwise runs the source registry
  // directly so dev environments without workflows still produce signals.
  if (event && (event as ScheduledEvent).cron === "0 * * * *") {
    ctx.waitUntil((async () => {
      // Task #2: hourly stuck-job sweep. Cheap (one indexed UPDATE) and
      // independent of queue traffic, so a quiet queue can still
      // converge on `timed_out` for any over-budget running rows.
      try {
        const swept = await sweepStuckJobs(env);
        if (swept > 0) console.log("hourly sweepStuckJobs", swept);
      } catch (e) {
        console.warn("hourly sweepStuckJobs failed", (e as Error).message);
      }
      // Task #2 (monitoring): hourly monitor-batch + digest run. Free-plan
      // cron slot cap (5) means the `*/15` cadence from the spec was
      // collapsed onto the hourly slot; the batch is bounded so an hour
      // of accumulated entity churn fits inside a single tick.
      try {
        if (env.WF_MONITOR_BATCH) {
          await env.WF_MONITOR_BATCH.create({ params: { limit: 500, staleMinutes: 15 } });
        } else {
          const { reevaluateAllSmartWatchlists } = await import("./monitoring/smart");
          const { pickDueEntities, monitorEntity, retryPendingDeliveries } = await import("./monitoring/dispatch");
          await reevaluateAllSmartWatchlists(env, { limit: 25 }).catch(() => undefined);
          const ids = await pickDueEntities(env, { limit: 200, staleMinutes: 15 });
          for (const id of ids) await monitorEntity(env, id).catch(() => undefined);
          await retryPendingDeliveries(env, 50).catch(() => undefined);
        }
      } catch (e) {
        console.error("hourly monitor-batch failed", (e as Error).message);
      }
      try {
        if (env.WF_DIGEST) {
          await env.WF_DIGEST.create({ params: { limit: 500 } });
        } else {
          const { runDigest } = await import("./monitoring/digest");
          await runDigest(env, { limit: 500 }).catch(() => undefined);
        }
      } catch (e) {
        console.error("hourly digest failed", (e as Error).message);
      }
      try {
        if (env.WF_CRAWL_SIGNALS) {
          await env.WF_CRAWL_SIGNALS.create({ params: {} });
          console.log("crawl-signals workflow dispatched");
        } else {
          const { MODULES } = await import("./prospects/sources/registry");
          const { runSource } = await import("./prospects/runCrawl");
          for (const mod of MODULES) await runSource(env, mod).catch((e) => console.warn("hourly runSource failed", mod.slug, (e as Error).message));
        }
      } catch (e) {
        console.error("hourly crawl-signals failed", (e as Error).message);
      }
    })());
    return;
  }
  // Cron 15 3 * * * → consolidated nightly job (Free plan caps crons at 5).
  // Runs every nightly task sequentially:
  //   1. analytics aggregator (lead_quality / source_kpis / pipeline_kpis /
  //      dashboard_snapshots rollups)
  //   2. account-score refresh (Task #44 — re-decay intent for stale rows)
  //   3. investor stats (Task #24 — counters + daily snapshot)
  //   4. relationship derivation (runs after analytics so today's entities
  //      are picked up)
  //   5. project match refresh (Task #47 — re-dispatch MatchProjectWorkflow
  //      for every active project)
  if (event && (event as ScheduledEvent).cron === "15 3 * * *") {
    ctx.waitUntil((async () => {
      // 1. Analytics aggregator
      try { await runNightlyAggregator(env); } catch (e) { console.error("nightly aggregator failed", (e as Error).message); }

      // 2. Account-score refresh
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

      // 3. Investor stats
      try {
        const r = await runInvestorStats(env);
        console.log("investor stats done", JSON.stringify(r));
      } catch (e) {
        console.error("investor stats failed", (e as Error).message);
      }

      // 4. Relationship derivation
      try {
        const r = await runRelationshipDerivation(env);
        console.log("relationship derivation done", JSON.stringify(r));
      } catch (e) {
        console.error("relationship derivation failed", (e as Error).message);
      }

      // 5a. Task #5: staleness sweep — entities not seen on any source
      // for >90 days are flagged `staleness='likely_dead'` for admin
      // review. Bounded so a single nightly tick can't churn through
      // the whole graph.
      try {
        const n = await sweepStaleEntities(env, 90, 2000);
        console.log("staleness sweep done", n);
      } catch (e) {
        console.error("staleness sweep failed", (e as Error).message);
      }

      // Task #8: nightly persona-entity match refresh — re-scores
      // persona_entity_matches rows older than 30 days. Bounded by
      // limit so a single tick fits in the cron window.
      try {
        // Migration-order guard: if 331's safety stubs are the only
        // copies of persona_matches / entity_legacy_map / u_entities
        // in this DB, the canonical migrations (170/200/280) never
        // ran here. In production this hard-fails the cron tick so
        // ops sees it; in dev it only logs.
        let stubMissingCanonical = false;
        try {
          const stubCheck = await env.DB.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='u_entities'`,
          ).first<{ name: string }>();
          if (stubCheck) {
            const colInfo = await env.DB.prepare(`PRAGMA table_info(u_entities)`).all<{ name: string }>();
            const cols = (colInfo.results ?? []).map((c) => c.name);
            // Canonical u_entities (mig 200) has display_name + quality_score;
            // the stub only carries id/kind/status. Missing cols => stub is canonical.
            if (!cols.includes("display_name") || !cols.includes("quality_score")) {
              stubMissingCanonical = true;
            }
          }
        } catch (e) {
          // PRAGMA / sqlite_master failures are environmental noise and
          // should not block the cron tick. Distinct from the
          // stubMissingCanonical signal which always propagates.
          console.warn("migration-order guard probe failed", (e as Error).message);
        }
        if (stubMissingCanonical) {
          const envName = (env as { ENVIRONMENT?: string }).ENVIRONMENT ?? "unknown";
          const msg = `SLO_VIOLATION migration_order_stub_active u_entities — apply migration 200 before relying on 331 (env=${envName})`;
          console.error(msg);
          // Hard-fail outside the probe try/catch so the throw is not
          // swallowed. Production deploys fail the cron tick; dev keeps going.
          if (envName === "production") {
            throw new Error(msg);
          }
        }

        if (env.WF_PERSONA_MATCH_REFRESH) {
          await env.WF_PERSONA_MATCH_REFRESH.create({ params: { limit: 500, staleDays: 30 } });
          console.log("persona-match-refresh workflow dispatched");
        } else {
          const { refreshStaleMatches } = await import("./services/personaMatching");
          const r = await refreshStaleMatches(env, { limit: 200, staleDays: 30 });
          console.log("persona-match-refresh inline", JSON.stringify(r));
        }
      } catch (e) {
        console.error("nightly persona-match-refresh failed", (e as Error).message);
      }

      // 5. Project match refresh
      try {
        const r = await env.DB.prepare(`SELECT id FROM projects WHERE deleted_at IS NULL AND status = 'active' ORDER BY last_modified DESC LIMIT 200`).all<{ id: string }>();
        for (const row of r.results ?? []) {
          if (env.WF_MATCH_PROJECT) {
            try { await env.WF_MATCH_PROJECT.create({ params: { projectId: row.id } }); }
            catch (e) { console.warn("nightly WF_MATCH_PROJECT.create failed", row.id, (e as Error).message); }
          } else {
            const { matchProject } = await import("./projects/match");
            try { await matchProject(env, row.id); }
            catch (e) { console.warn("nightly matchProject failed", row.id, (e as Error).message); }
          }
        }
      } catch (e) {
        console.error("nightly project match refresh failed", (e as Error).message);
      }
    })());
    return;
  }
  // Cron 0 4 * * * → Task #3 daily DD watchlist refresh + batch scan.
  // Dispatches DDScanBatchWorkflow when bound; otherwise runs inline so
  // dev environments without workflows still produce risk scores.
  // Cron 30 4 * * * → Task #3 (research agent) nightly saved-research
  // refresh. Re-runs every saved question (headless agent loop) and
  // writes a structured diff back to saved_research.diff_json. Capped
  // at 50 saved rows / tick inside the workflow itself.
  if (event && (event as ScheduledEvent).cron === "30 4 * * *") {
    ctx.waitUntil((async () => {
      try {
        if (env.WF_REFRESH_SAVED_RESEARCH) {
          await env.WF_REFRESH_SAVED_RESEARCH.create({ params: {} });
          console.log("refresh-saved-research workflow dispatched");
        } else {
          const { RefreshSavedResearchWorkflow } = await import("./agent/workflow");
          const wf = new RefreshSavedResearchWorkflow(ctx, env);
          const r = await wf.run({ payload: {} }, {
            do: async (_n, _o, fn) => fn(),
            sleep: async () => undefined,
          });
          console.log("refresh-saved-research inline", JSON.stringify(r));
        }
      } catch (e) {
        console.error("refresh-saved-research failed", (e as Error).message);
      }
    })());
    return;
  }
  if (event && (event as ScheduledEvent).cron === "0 4 * * *") {
    ctx.waitUntil((async () => {
      try {
        if (env.WF_DD_SCAN_BATCH) {
          await env.WF_DD_SCAN_BATCH.create({ params: { limit: 100, staleDays: 7 } });
          console.log("dd-scan-batch workflow dispatched");
        } else {
          const { refreshAllWatchlists, batchScanDueEntities } = await import("./dd/watchlistRefresh");
          const wl = await refreshAllWatchlists(env);
          console.log("dd watchlist refresh", JSON.stringify({ refreshed: wl.refreshed, failed: wl.failed }));
          const sc = await batchScanDueEntities(env, { limit: 100, staleDays: 7 });
          console.log("dd batch scan", JSON.stringify(sc));
        }
      } catch (e) {
        console.error("daily dd-scan-batch failed", (e as Error).message);
      }
      // Task #2: nightly news refresh for the top-N highest-quality
      // entities. Bounded so a single tick stays well under cron limits.
      try {
        const { ensureSeeded } = await import("./news/reputability");
        await ensureSeeded(env);
        const top = await env.DB.prepare(
          `SELECT id FROM u_entities WHERE status='active' AND display_name IS NOT NULL
            ORDER BY quality_score DESC, updated_at DESC LIMIT 50`,
        ).all<{ id: string }>();
        let dispatched = 0;
        for (const r of top.results ?? []) {
          try {
            if (env.WF_REFRESH_NEWS) {
              await env.WF_REFRESH_NEWS.create({ params: { entityId: r.id, triggered_by: "cron:nightly" } });
            } else {
              const { refreshEntityNews } = await import("./news/refresh");
              await refreshEntityNews(env, r.id, { maxArticles: 25 });
            }
            dispatched++;
          } catch (e) {
            console.warn("nightly news refresh failed", r.id, (e as Error).message);
          }
        }
        console.log("nightly news refresh dispatched", dispatched);
      } catch (e) {
        console.error("nightly news refresh batch failed", (e as Error).message);
      }
      // Task #3: nightly profile classification. Picks the next N
      // stalest entities and classifies each — types + ideology +
      // interests + influence + AI summary. Piggybacks this cron slot
      // (Free plan caps crons at 5).
      try {
        if (env.WF_CLASSIFY_BATCH) {
          await env.WF_CLASSIFY_BATCH.create({ params: { limit: 50, staleDays: 7 } });
          console.log("classify-batch workflow dispatched");
        } else {
          const { classifyBatch } = await import("./profile/classifier");
          const r = await classifyBatch(env, { limit: 25, staleDays: 7 });
          console.log("classify-batch inline", JSON.stringify(r));
        }
      } catch (e) {
        console.error("nightly classify-batch failed", (e as Error).message);
      }
      // Task #3 (this task): nightly OSINT batch + 90-day reverify sweep.
      // Free-plan cron slot cap (5/5 booked) means we piggyback the 0 4
      // slot. Both jobs are bounded so they fit inside a single tick.
      try {
        if (env.WF_OSINT_BATCH) {
          await env.WF_OSINT_BATCH.create({ params: { limit: 25, staleDays: 30 } });
          console.log("osint-batch workflow dispatched");
        } else {
          const { resolveEntity } = await import("./osint/resolve");
          const r = await env.DB.prepare(
            `SELECT e.id FROM u_entities e
               LEFT JOIN osint_entity_state s ON s.entity_id = e.id
              WHERE e.status='active' AND e.display_name IS NOT NULL
                AND (s.last_osint_run_at IS NULL OR datetime(s.last_osint_run_at) < datetime('now','-30 days'))
              ORDER BY (s.last_osint_run_at IS NULL) DESC, s.last_osint_run_at ASC
              LIMIT 10`,
          ).all<{ id: string }>();
          for (const row of r.results ?? []) {
            try { await resolveEntity(env, row.id, { totalBudgetMs: 30_000 }); }
            catch (e) { console.warn("inline osint resolve failed", row.id, (e as Error).message); }
          }
        }
      } catch (e) {
        console.error("nightly osint-batch failed", (e as Error).message);
      }
      try {
        if (env.WF_OSINT_REVERIFY) {
          await env.WF_OSINT_REVERIFY.create({ params: { limit: 200 } });
          console.log("osint-reverify workflow dispatched");
        } else {
          const { reverifyDueHandles } = await import("./osint/reverify");
          const r = await reverifyDueHandles(env, { limit: 100, maxAgeDays: 90 });
          console.log("osint-reverify inline", JSON.stringify(r));
        }
      } catch (e) {
        console.error("nightly osint-reverify failed", (e as Error).message);
      }
    })());
    return;
  }
  // Task #5: every 6h, the registry is the source of truth. We enqueue
  // a firmlist job for every enabled row whose `next_run_after` has
  // passed (or is null) — capped at 200/tick so a single cron tick
  // doesn't melt the queue. On first deploy, populate the registry
  // from seed-sources.json so it isn't empty.
  const registryDue = await env.DB.prepare(
    `SELECT * FROM source_registry
       WHERE enabled = 1
         AND last_run_status != 'running'
         AND (next_run_after IS NULL OR datetime(next_run_after) <= datetime('now'))
       ORDER BY COALESCE(next_run_after, added_at) ASC LIMIT 200`,
  ).all<SourceRow>();
  const registryRows = registryDue.results ?? [];

  const enqueueRegistry = async () => {
    if (registryRows.length === 0) {
      // First-deploy bootstrap: registry is empty, populate from seeds.
      const probe = await env.DB.prepare(`SELECT COUNT(*) AS n FROM source_registry`).first<{ n: number }>();
      if (!probe || probe.n === 0) {
        try {
          const r = await loadSeedSources(env);
          console.log("source_registry first-deploy bootstrap", JSON.stringify(r));
        } catch (e) {
          console.warn("source_registry bootstrap failed", (e as Error).message);
        }
      }
      return;
    }
    for (const row of registryRows) {
      try { await enqueueSourceRun(env, row, { trigger: "cron" }); }
      catch (e) { console.warn("registry enqueue failed", row.url, (e as Error).message); }
    }
  };

  // Legacy `sources` table — kept for backwards compatibility with
  // per-domain re-scrapes that pre-date the registry (Task #5).
  const r = await env.DB.prepare(
    `SELECT id, domain FROM sources
       WHERE enabled = 1
         AND (last_scraped_at IS NULL OR datetime(last_scraped_at) < datetime('now','-24 hours'))
       LIMIT 200`,
  ).all<LegacySourceRow>();
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

  ctx.waitUntil(enqueueRegistry());
  ctx.waitUntil(enqueueScrapes());
  ctx.waitUntil(reEnrichStale());
}
