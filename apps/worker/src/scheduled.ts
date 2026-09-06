import type { Env, JobMessage } from "./types";
import { enrichLead } from "./enrichment/orchestrator";
import { runNightlyAggregator } from "./services/analytics_v2.aggregator";
import { runRelationshipDerivation } from "./scraper/relationships/derive";
import { runInvestorStats } from "./services/investor_stats";
import { materializeInvestorPortfolio } from "./services/investor_portfolio";
import { recomputeStaleAccountScores } from "./prospects/repo";
import type { Lead } from "./db/leads.types";
import { ensureRoleTaxonomySeeded } from "./prospects/seedRoles";
// Task #5: source registry — drives the 6h cron + nightly staleness sweep.
import { enqueueSourceRun, sweepStaleEntities, type SourceRow } from "./sources/registry";
import { loadSeedSources } from "./sources/seed_loader";
// Task #2: periodic stuck-job sweeper. Guarantees timeout convergence
// even when queue traffic is too low to trigger the batch-head sweep.
import { sweepStuckJobs } from "./routes/admin";
import { sweepStuckImports } from "./imports/import";
// Task #3: hourly crawler-seed sweep — picks up to 100 stalest enabled
// seeds whose refresh interval has elapsed and enqueues them.
import { runSeedSweep } from "./services/crawlerSeeds/sweep";
// Task #51: route previously-swallowed cron sub-task failures through the
// structured error logger. Each is still non-blocking so one failing
// sub-task can't abort the rest of the cron tick.
import { logError } from "./db/error_log";

interface LegacySourceRow {
  id: string;
  domain: string;
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
        await logError(env, { err: e, step: "hourly sweepStuckJobs" });
        console.warn("hourly sweepStuckJobs failed", (e as Error).message);
      }
      // Task #63: recover legacy file imports stuck in 'importing'. Resumes
      // chunked imports from their persisted cursor; escalates true no-progress
      // stalls to 'error' so a killed isolate never leaves a permanent spinner.
      try {
        const r = await sweepStuckImports(env);
        if (r.resumed > 0 || r.failed > 0) console.log("hourly sweepStuckImports", r);
      } catch (e) {
        await logError(env, { err: e, step: "hourly sweepStuckImports" });
        console.warn("hourly sweepStuckImports failed", (e as Error).message);
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
          await reevaluateAllSmartWatchlists(env, { limit: 25 }).catch((e) => logError(env, { err: e, step: "hourly.monitor.reevaluateSmartWatchlists" }));
          const ids = await pickDueEntities(env, { limit: 200, staleMinutes: 15 });
          for (const id of ids) await monitorEntity(env, id).catch((e) => logError(env, { err: e, step: "hourly.monitor.monitorEntity" }));
          await retryPendingDeliveries(env, 50).catch((e) => logError(env, { err: e, step: "hourly.monitor.retryPendingDeliveries" }));
        }
      } catch (e) {
        await logError(env, { err: e, step: "hourly monitor-batch" });
        console.error("hourly monitor-batch failed", (e as Error).message);
      }
      try {
        if (env.WF_DIGEST) {
          await env.WF_DIGEST.create({ params: { limit: 500 } });
        } else {
          const { runDigest } = await import("./monitoring/digest");
          await runDigest(env, { limit: 500 }).catch((e) => logError(env, { err: e, step: "hourly.digest.runDigest" }));
        }
      } catch (e) {
        await logError(env, { err: e, step: "hourly digest" });
        console.error("hourly digest failed", (e as Error).message);
      }
      // Task #3: hourly seed sweep. Idempotent — touches last_crawled_at
      // before enqueue so a re-tick within the same hour is a no-op.
      // Task #2: short-circuit if the operator has paused the crawler
      // globally (seed sweep is the primary enqueue source).
      try {
        const { isGlobalPaused } = await import("./services/ops/pause");
        if (await isGlobalPaused(env)) {
          console.log("hourly seed sweep skipped: crawler paused");
        } else {
        const seedRes = await runSeedSweep(env, 100);
        if (seedRes.picked > 0) console.log("hourly seed sweep", JSON.stringify(seedRes));
        }
      } catch (e) {
        await logError(env, { err: e, step: "hourly seed sweep" });
        console.error("hourly seed sweep failed", (e as Error).message);
      }
      // Task #3 (review fix): drain smart_frontier into crawl_frontier so
      // expander-emitted candidates actually become crawler work. Bounded
      // (200/tick) so a packed staging area can't starve other hourly jobs.
      try {
        const { drainSmartFrontier } = await import("./services/frontier/drain");
        const drainRes = await drainSmartFrontier(env, 200);
        if (drainRes.picked > 0) console.log("hourly smart_frontier drain", JSON.stringify(drainRes));
      } catch (e) {
        await logError(env, { err: e, step: "hourly smart_frontier drain" });
        console.error("hourly smart_frontier drain failed", (e as Error).message);
      }
      // Task #1: SEC EDGAR discovery tick. RSS hourly + daily-index pass
      // at 02:00 UTC. Both channels stage filings into the crawl
      // frontier; the engine fetches them and the secEdgar adapter +
      // persist layer write through insertFact + sec_* tables.
      try {
        const { runEdgarDiscoveryTick } = await import("./services/secEdgar/discovery");
        const edgarRes = await runEdgarDiscoveryTick(env);
        if (edgarRes.rss.staged > 0 || edgarRes.daily?.staged) {
          console.log("hourly edgar discovery", JSON.stringify(edgarRes));
        }
      } catch (e) {
        await logError(env, { err: e, step: "hourly edgar discovery" });
        console.error("hourly edgar discovery failed", (e as Error).message);
      }
      // Task #2 (People-at-Firms Tracker): weekly firm team-page
      // snapshot + diff + corroborate + spinout + carry-heuristic.
      // Piggybacks the hourly tick (Free plan caps crons at 5/5).
      // Each phase is bounded so a single tick fits in the budget;
      // per-firm gating in snapshot.runWeeklySnapshotSweep ensures a
      // firm is only re-snapshotted if its last snapshot is >7d old.
      try {
        const { runWeeklySnapshotSweep } = await import("./services/movements/snapshot");
        const snapRes = await runWeeklySnapshotSweep(env, 25);
        if (snapRes.picked > 0) console.log("hourly movements snapshot", JSON.stringify(snapRes));
      } catch (e) {
        await logError(env, { err: e, step: "hourly movements snapshot" });
        console.error("hourly movements snapshot failed", (e as Error).message);
      }
      try {
        const { runDiffSweep } = await import("./services/movements/differ");
        const diffRes = await runDiffSweep(env, 50);
        if (diffRes.firms > 0) console.log("hourly movements diff", JSON.stringify(diffRes));
      } catch (e) {
        await logError(env, { err: e, step: "hourly movements diff" });
        console.error("hourly movements diff failed", (e as Error).message);
      }
      try {
        const { runCorroborationSweep } = await import("./services/movements/corroborate");
        const corrRes = await runCorroborationSweep(env, 100);
        if (corrRes.picked > 0) console.log("hourly movements corroborate", JSON.stringify(corrRes));
      } catch (e) {
        await logError(env, { err: e, step: "hourly movements corroborate" });
        console.error("hourly movements corroborate failed", (e as Error).message);
      }
      try {
        const { runSpinoutSweep } = await import("./services/movements/spinout");
        const spinRes = await runSpinoutSweep(env, 50);
        if (spinRes.spinouts_emitted > 0) console.log("hourly movements spinout", JSON.stringify(spinRes));
      } catch (e) {
        await logError(env, { err: e, step: "hourly movements spinout" });
        console.error("hourly movements spinout failed", (e as Error).message);
      }
      try {
        const { runCarrySweep } = await import("./services/movements/carry");
        const carryRes = await runCarrySweep(env, 25);
        if (carryRes.firms > 0) console.log("hourly movements carry", JSON.stringify(carryRes));
      } catch (e) {
        await logError(env, { err: e, step: "hourly movements carry" });
        console.error("hourly movements carry failed", (e as Error).message);
      }
      // Task #2: hourly adapter-drift check. Compares parse-success rate
      // over the last 7 days vs the prior 7 days for each profile-type
      // workflow; emits one ops_audit row per significant drop (>=30pp).
      // Piggybacks the hourly tick (Free plan caps crons at 5/5).
      try {
        const drift = await env.DB.prepare(
          `WITH recent AS (
              SELECT profile_type_id,
                     COUNT(*) AS n,
                     SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS rate
                FROM profile_workflow_runs
               WHERE run_at >= datetime('now','-7 days')
               GROUP BY profile_type_id
              HAVING COUNT(*) >= 5),
            prior AS (
              SELECT profile_type_id,
                     COUNT(*) AS n,
                     SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS rate
                FROM profile_workflow_runs
               WHERE run_at >= datetime('now','-14 days') AND run_at < datetime('now','-7 days')
               GROUP BY profile_type_id
              HAVING COUNT(*) >= 5)
            SELECT r.profile_type_id, r.rate AS recent_rate, p.rate AS prior_rate,
                   r.n AS recent_n, p.n AS prior_n
              FROM recent r JOIN prior p USING (profile_type_id)
             WHERE (p.rate - r.rate) >= 0.30`,
        ).all<{ profile_type_id: string; recent_rate: number; prior_rate: number; recent_n: number; prior_n: number }>();
        for (const d of drift.results ?? []) {
          const payload = {
            recent_success_rate: +d.recent_rate.toFixed(3),
            prior_success_rate: +d.prior_rate.toFixed(3),
            drop_pp: +(((d.prior_rate - d.recent_rate) * 100)).toFixed(1),
            recent_n: d.recent_n, prior_n: d.prior_n,
          };
          await env.DB.prepare(
            `INSERT INTO ops_audit (actor_email, action, target_kind, target_id, payload_json)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(
            "system:drift-monitor", "drift.detected",
            "profile_type", d.profile_type_id, JSON.stringify(payload),
          ).run();
          // Also emit into the alert_events pipeline so the operator
          // alert/insight surfaces consume drift the same way as any
          // other monitoring event. trigger_kind='crawler_drift' is a
          // free-form text column (no CHECK constraint on this field
          // in migration 280); owner is the admin allowlist root.
          try {
            const owner = (env.ALLOWED_EMAIL || "system:drift-monitor").split(",")[0].trim().toLowerCase();
            const today = new Date().toISOString().slice(0, 10);
            const dedupeKey = `${d.profile_type_id}|${today}`;
            const dedupeData = new TextEncoder().encode(`system:crawler-drift|${d.profile_type_id}|crawler_drift|${dedupeKey}`);
            const buf = await crypto.subtle.digest("SHA-256", dedupeData);
            const hash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
            // Deterministic id derived from dedupe_hash → ON CONFLICT
            // on the PRIMARY KEY enforces daily idempotency without a
            // migration. alert_events has no UNIQUE on dedupe_hash, so
            // we piggyback on the id PK by deriving a stable id.
            const id = `drift:${hash.slice(0, 32)}`;
            await env.DB.prepare(
              `INSERT INTO alert_events
                 (id, owner_email, rule_id, watchlist_id, entity_id, trigger_kind,
                  dedupe_key, dedupe_hash, title, body, payload_json, channel,
                  delivery_status, occurred_at)
               VALUES (?, ?, 'system:crawler-drift', NULL, ?, 'crawler_drift',
                       ?, ?, ?, ?, ?, 'in_app', 'delivered', datetime('now'))
               ON CONFLICT(id) DO NOTHING`,
            ).bind(
              id, owner, d.profile_type_id,
              dedupeKey, hash,
              `Crawler drift: ${d.profile_type_id}`,
              `Parse-success rate dropped ${payload.drop_pp}pp (from ${(payload.prior_success_rate*100).toFixed(0)}% to ${(payload.recent_success_rate*100).toFixed(0)}%) over the last 7 days.`,
              JSON.stringify(payload),
            ).run();
          } catch (e) { console.warn("alert_events drift insert failed", (e as Error).message); }
        }
        if ((drift.results ?? []).length > 0) {
          console.log("hourly drift check flagged", JSON.stringify({ count: (drift.results ?? []).length }));
        }
      } catch (e) {
        await logError(env, { err: e, step: "hourly drift check" });
        console.warn("hourly drift check failed", (e as Error).message);
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
        await logError(env, { err: e, step: "hourly crawl-signals" });
        console.error("hourly crawl-signals failed", (e as Error).message);
      }

      // Task #5 (System Health): hourly rollup write + alert evaluator
      // tick + cron-tick marker. Piggybacks the hourly slot (Free plan
      // caps crons at 5/5 — same constraint as the other piggybacks
      // above). The aggregator endpoint additionally writes an
      // on-demand snapshot when the last bucket is >5min old so live
      // page reads see fresh data between cron ticks.
      try {
        const { writeHealthSnapshot, markCronTick } = await import("./services/systemHealth/snapshot");
        const snap = await writeHealthSnapshot(env);
        await markCronTick(env, "0 * * * *");
        console.log("hourly system-health snapshot", JSON.stringify(snap));
      } catch (e) {
        await logError(env, { err: e, step: "hourly system-health snapshot" });
        console.error("hourly system-health snapshot failed", (e as Error).message);
      }
      try {
        const { runAlertEvaluator } = await import("./services/systemHealth/alerts");
        const r = await runAlertEvaluator(env);
        if (r.opened > 0 || r.closed > 0) {
          console.log("hourly system-health alerts", JSON.stringify(r));
        }
      } catch (e) {
        await logError(env, { err: e, step: "hourly system-health alerts" });
        console.error("hourly system-health alerts failed", (e as Error).message);
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
      // Task #5 (System Health): nightly external-API probe sweep. One
      // cheap GET per registered API; writes to external_api_probes.
      // Piggybacks the consolidated nightly slot (Free plan caps crons
      // at 5/5). Mark the nightly cron tick so the cron-status panel
      // surfaces it on /ops/system-health/.
      try {
        const { runAllProbes } = await import("./services/systemHealth/probes");
        const probes = await runAllProbes(env);
        const failed = probes.filter((p) => !p.ok && p.configured).length;
        const unconfigured = probes.filter((p) => !p.configured).length;
        console.log("nightly external-api probes", JSON.stringify({ probed: probes.length, failed, unconfigured }));
        const { markCronTick } = await import("./services/systemHealth/snapshot");
        await markCronTick(env, "15 3 * * *");
      } catch (e) {
        await logError(env, { err: e, step: "nightly external-api probes" });
        console.error("nightly external-api probes failed", (e as Error).message);
      }

      // Task #3 (Editable Profiles): unlock_after expiry sweep. Flips
      // locked=0 on overrides whose unlock_after has passed (originally
      // set by a bulk_revert or admin unlock), clears
      // superseded_by_override on matching facts, and enqueues a summary
      // rebuild. Bounded so a backlog can't dominate the nightly slot.
      try {
        const { runOverrideUnlockSweep } = await import("./routes/overrides");
        const r = await runOverrideUnlockSweep(env, 500);
        if (r.unlocked > 0) console.log("nightly override unlock sweep", r.unlocked);
      } catch (e) {
        await logError(env, { err: e, step: "nightly override unlock sweep" });
        console.error("nightly override unlock sweep failed", (e as Error).message);
      }

      // Task #8: ML Quality Ops nightly — runs the full eval sweep
      // over every active gold dataset, then grades any
      // `predictions` rows whose time-window closed. Wrapped in
      // try/catch so its failure doesn't block downstream nightly
      // jobs (analytics, account scoring, etc).
      try {
        const { runAllActive } = await import("./services/mlOps/runner");
        const { predictorFor } = await import("./services/mlOps/predictors");
        await runAllActive(env, predictorFor, { triggered_by: "nightly", model_version: "heuristic:v1" });
      } catch (e) {
        await logError(env, { err: e, step: "nightly ml eval sweep" });
        console.error("nightly ml eval sweep failed", (e as Error).message);
      }
      try {
        const { runCalibrationGrade } = await import("./services/mlOps/calibration");
        const r = await runCalibrationGrade(env);
        console.log("nightly calibration grade", r.graded, "per type", r.perType.length);
      } catch (e) {
        await logError(env, { err: e, step: "nightly calibration grade" });
        console.error("nightly calibration grade failed", (e as Error).message);
      }

      // 1. Analytics aggregator
      try {
        await runNightlyAggregator(env);
      } catch (e) {
        await logError(env, { err: e, step: "nightly aggregator" });
        console.error("nightly aggregator failed", (e as Error).message);
      }

      // 2. Account-score refresh. Task #54: batched sweep — a fixed read
      // budget (accounts + signals + buyers + one taxonomy load) plus
      // chunked batch updates, instead of the prior per-account N+1 of up
      // to 1000 × (getAccount + signals + listBuyers + taxonomy reload).
      try {
        await ensureRoleTaxonomySeeded(env);
        const r = await recomputeStaleAccountScores(env, 1000);
        console.log("nightly account scores done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "nightly account scores" });
        console.error("nightly account scores failed", (e as Error).message);
      }

      // 2b. Task #31: materialize investor portfolios from firm_portfolio +
      // leads.companies_json into investor_investments (creating backing
      // companies rows when untracked) so the investor profile page is
      // populated. Runs BEFORE investor stats so the counters below reflect
      // the freshly-materialized rows.
      try {
        const r = await materializeInvestorPortfolio(env);
        console.log("investor portfolio materialize done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "investor portfolio materialize" });
        console.error("investor portfolio materialize failed", (e as Error).message);
      }

      // 3. Investor stats
      try {
        const r = await runInvestorStats(env);
        console.log("investor stats done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "investor stats" });
        console.error("investor stats failed", (e as Error).message);
      }

      // 4. Relationship derivation
      try {
        const r = await runRelationshipDerivation(env);
        console.log("relationship derivation done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "relationship derivation" });
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
        await logError(env, { err: e, step: "staleness sweep" });
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
        const msg = (e as Error).message;
        await logError(env, { err: e, step: "nightly persona-match-refresh" });
        console.error("nightly persona-match-refresh failed", msg);
        // NOTE: this used to re-throw `migration_order_stub_active` so the
        // cron tick would "fail". The chain runs inside ctx.waitUntil, so a
        // throw here never fails the tick — it only aborted the ~17 sweeps
        // that follow (fund refresh … project match) every night until the
        // migration landed. The error_log row above is the durable signal;
        // keep the chain running.
        if (msg.includes("migration_order_stub_active")) {
          console.error("SLO: persona-match-refresh blocked by migration order; continuing nightly chain");
        }
      }

      // Task #3 (Fund Intelligence Engine): nightly per-fund ledger
      // refresh — re-assembles ADV / Form D / LP / deal-flow signals
      // into the structured `funds` table and emits firm-level facts
      // (latest_fund_vintage, latest_fund_size_usd, strategy_drift)
      // via the canonical insertFact path. Bounded at 50 funds/tick.
      try {
        const { runFundRefreshSweep } = await import("./services/funds/assemble");
        const r = await runFundRefreshSweep(env, 50);
        console.log("fund refresh sweep done", JSON.stringify(r));
        const { computeStrategyDrift } = await import("./services/funds/strategyDrift");
        // Drift is per-fund per-month — recompute for every fund whose
        // ledger row was refreshed in the last 2 days.
        const fundsForDrift = await env.DB.prepare(
          `SELECT id FROM funds
            WHERE updated_at >= datetime('now','-2 day')
            LIMIT 200`,
        ).all<{ id: string }>();
        let drifts = 0;
        for (const f of fundsForDrift.results ?? []) {
          try { await computeStrategyDrift(env, f.id); drifts++; }
          catch (e) { console.warn("strategy drift failed", f.id, (e as Error).message); }
        }
        console.log("fund strategy drift done", drifts);
      } catch (e) {
        await logError(env, { err: e, step: "nightly fund refresh" });
        console.error("nightly fund refresh failed", (e as Error).message);
      }

      // Task #2 (Fund-Return Modeling): nightly DPI/TVPI/MOIC inference
      // from public exits + Form D + LP disclosures. Models every
      // eligible fund each night (oldest-modeled-first rotation, hard
      // safety ceiling 5000/tick; see runNightlyFundReturnSweep).
      // Piggybacks the consolidated nightly slot (Free plan caps crons
      // at 5/5). Calibration loop is recomputed after the sweep so the
      // next run picks up any newly disclosed LP actuals.
      try {
        const { runNightlyFundReturnSweep } = await import("./services/fundReturns/model");
        const fr = await runNightlyFundReturnSweep(env);
        console.log("nightly fund return sweep done", JSON.stringify(fr));
        const { rebuildCalibration } = await import("./services/fundReturns/calibration");
        const cal = await rebuildCalibration(env);
        console.log("nightly fund return calibration done", JSON.stringify(cal));
      } catch (e) {
        await logError(env, { err: e, step: "nightly fund return sweep" });
        console.error("nightly fund return sweep failed", (e as Error).message);
      }

      // Task #4 (Angel & Syndicate Network Mapper): nightly per-angel
      // ledger refresh + syndicate analytics rebuild. Piggybacks on this
      // consolidated nightly slot — Free plan caps crons at 5.
      try {
        const { refreshAllAngels } = await import("./services/angels/assemble");
        const angelsRefreshed = await refreshAllAngels(env, 500);
        console.log("angel refresh sweep done", angelsRefreshed);
        const { refreshAllSyndicateAnalytics } = await import("./services/angels/syndicateAnalytics");
        const syndRefreshed = await refreshAllSyndicateAnalytics(env);
        console.log("syndicate analytics rebuild done", syndRefreshed);
      } catch (e) {
        await logError(env, { err: e, step: "nightly angel/syndicate refresh" });
        console.error("nightly angel/syndicate refresh failed", (e as Error).message);
      }

      // Task #3 (International Coverage Pack): nightly intl filings
      // drain — pulls recent filings from each of the 17 jurisdictional
      // adapters since the last successful drain (KV cursor) and routes
      // them through persistIntlFiling for USD normalization +
      // translation + canonical fact writes. Per-adapter errors are
      // isolated. Piggybacks the consolidated nightly slot (Free plan
      // caps crons at 5).
      try {
        const { drainAllIntlFilings } = await import("./services/intl/drain");
        const intlSummary = await drainAllIntlFilings(env, { defaultDaysBack: 7, perAdapterCap: 50 });
        const totals = intlSummary.reduce((a, s) => ({
          seen: a.seen + s.filings_seen,
          persisted: a.persisted + s.filings_persisted,
          fx_errors: a.fx_errors + s.fx_errors,
          translated: a.translated + s.translated,
        }), { seen: 0, persisted: 0, fx_errors: 0, translated: 0 });
        console.log("intl filings drain done", totals);
      } catch (e) {
        await logError(env, { err: e, step: "nightly intl drain" });
        console.error("nightly intl drain failed", (e as Error).message);
      }

      // Task #9 (Valuation Intelligence): nightly comp-panel refresh —
      // re-screens any comp_panels whose `last_refreshed_at` is older
      // than the staleHours cutoff (default 28 days = monthly cadence
      // per spec). Bounded at 50 panels/tick by the function's
      // internal LIMIT; idempotent (membership snapshot is replaced
      // wholesale per refresh). Free plan caps crons at 5 so this
      // piggybacks on the consolidated nightly slot.
      try {
        const { refreshStaleCompPanels } = await import("./services/valuation/compPanel");
        // Default staleHours = 24*28 (monthly cadence per spec); the
        // function itself caps the per-tick refresh count at 50.
        const compRes = await refreshStaleCompPanels(env);
        console.log("comp-panel refresh sweep done", JSON.stringify(compRes));
      } catch (e) {
        await logError(env, { err: e, step: "nightly comp-panel refresh" });
        console.error("nightly comp-panel refresh failed", (e as Error).message);
      }

      // Task #4: Monday capital-markets weekly digest. Folded into this
      // nightly tick (Free plan caps crons at 5/5). Internal Monday-UTC
      // gate inside runCapitalMarketsWeeklyDigest — non-Monday runs are
      // cheap no-ops.
      try {
        const { runCapitalMarketsWeeklyDigest } = await import("./monitoring/capitalDigest");
        const r = await runCapitalMarketsWeeklyDigest(env);
        console.log("capital-markets weekly digest done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "capital-markets weekly digest" });
        console.error("capital-markets weekly digest failed", (e as Error).message);
      }

      // Task #14: Background verification + reference-network nightly
      // sweep. Re-verifies up to 200 stalest persons whose Verification
      // tab was viewed in the last 30 days OR whose claims changed.
      // Bounded per-tick. Piggybacks the consolidated nightly slot
      // (Free plan caps crons at 5/5).
      try {
        const { runNightlyVerificationSweep, pickReferenceGraphChanged } = await import("./services/verification/runner");
        const { buildReferenceCandidates } = await import("./services/verification/references");
        const verifyRes = await runNightlyVerificationSweep(env, 200);
        console.log("nightly verification sweep done", JSON.stringify({ picked: verifyRes.picked, findings: verifyRes.findings, claims_changed: verifyRes.claims_changed }));
        // Rebuild references for (a) persons we just re-verified AND
        // (b) persons whose reference-graph hash changed independently
        // of verification claims (graph-only deltas — new publication,
        // new board seat, new co-attendee). Bounded at 200/tick.
        const graphPicks = await pickReferenceGraphChanged(env, 200);
        const rebuildIds = Array.from(new Set([...verifyRes.verified_ids, ...graphPicks]));
        let refs = 0;
        for (const id of rebuildIds) {
          try {
            const s = await buildReferenceCandidates(env, id);
            refs += s.total;
          } catch (e) { console.warn("ref builder failed", id, (e as Error).message); }
        }
        console.log("nightly reference-network build done", JSON.stringify({ rebuilt: rebuildIds.length, graph_changed: graphPicks.length, candidates: refs }));
      } catch (e) {
        await logError(env, { err: e, step: "nightly verification sweep" });
        console.error("nightly verification sweep failed", (e as Error).message);
      }

      // Task #18: nightly leak harvester + Delaware COI sweep. Both
      // fast-return as `unconfigured` when their env vars are absent
      // (PACER-honesty pattern from Task #14), so this block is safe
      // to enable unconditionally. Bounded at 25 Delaware fetches per
      // tick when configured. Leak candidates are NOT auto-persisted —
      // operators promote via the admin endpoint.
      try {
        const { harvestRecentLeaks } = await import("./services/termSheets/leakHarvester");
        const leaks = await harvestRecentLeaks(env);
        console.log("nightly leak harvest", JSON.stringify({ status: leaks.status, candidates: leaks.candidates.length, reason: leaks.reason }));
      } catch (e) {
        await logError(env, { err: e, step: "nightly leak harvest" });
        console.error("nightly leak harvest failed", (e as Error).message);
      }
      try {
        const { fetchDelawareCoi } = await import("./services/termSheets/delawareCoi");
        const { upsertPreferredSeries } = await import("./services/termSheets/persist");
        // Pick up to 25 recently-active companies that have NO current
        // preferred_series row yet. The fetcher will fast-return
        // `unconfigured` if env is missing; in that case this loop
        // exits after the first probe.
        const rows = await env.DB.prepare(`
          SELECT e.id, e.display_name
            FROM u_entities e
            LEFT JOIN preferred_series ps
              ON ps.company_entity_id = e.id AND ps.is_current = 1
           WHERE ps.id IS NULL AND e.display_name IS NOT NULL
           ORDER BY e.updated_at DESC
           LIMIT 25
        `).all<{ id: string; display_name: string }>();
        let probed = 0; let extracted = 0; let unconfigured = false;
        for (const r of rows.results ?? []) {
          const res = await fetchDelawareCoi(env, r.display_name);
          probed++;
          if (res.status === "unconfigured") { unconfigured = true; break; }
          if (res.status === "extracted" && res.extraction) {
            for (const series of res.extraction.series) {
              try {
                await upsertPreferredSeries(env, {
                  company_entity_id: r.id, series,
                  source: "delaware_coi", source_kind: "import",
                  source_url: res.source_url ?? null, source_accession_no: null,
                });
                extracted++;
              } catch (e) { console.warn("delaware_coi upsert failed", r.id, (e as Error).message); }
            }
          }
        }
        console.log("nightly delaware coi sweep", JSON.stringify({ probed, extracted, unconfigured }));
      } catch (e) {
        await logError(env, { err: e, step: "nightly delaware coi sweep" });
        console.error("nightly delaware coi sweep failed", (e as Error).message);
      }



      // Task #18: nightly term-benchmarks rebuild. Re-buckets every
      // current preferred_series row by (stage, sector, year) and
      // upserts term_benchmarks. Cheap (single SELECT + N upserts);
      // piggybacks the consolidated nightly slot. Per the Task #4
      // operational note Free plan caps crons at 5/5.
      try {
        const { rebuildTermBenchmarks } = await import("./services/termSheets/benchmarks");
        const r = await rebuildTermBenchmarks(env);
        console.log("term benchmarks rebuild done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "nightly term-benchmarks rebuild" });
        console.error("nightly term-benchmarks rebuild failed", (e as Error).message);
      }

      // Task #4 (Relationship Inference Worker): nightly relationship
      // inference. Two phases:
      //  1) drainInferQueue — per-entity orchestrator passes for any
      //     entities that landed in relationship_infer_queue since the
      //     previous tick (debounced from createEntity / insertFact).
      //  2) full pass — runAllExtractors with no entity scope so any
      //     newly-arrived source rows that didn't fire the per-entity
      //     hook (bulk imports, backfills) still get edges emitted.
      // Piggybacks the consolidated nightly slot (Free plan caps crons
      // at 5/5 — same constraint as Task #4 angel sweep, Task #14
      // verification, Task #18 benchmarks, Task #2 fund returns,
      // Task #3 edge quality, Task #4 intro retrain, Task #5 reputation).
      // Runs BEFORE the Task #3 edge-quality sweep so freshly-emitted
      // edges get scored in the same tick. That ordering is load-bearing
      // and was not actually held: the edge-quality sweep used to sit ~50
      // lines earlier in this chain, so every edge minted here waited a
      // full night to be scored, another to be PageRanked, and Power Nodes
      // trailed the graph by two days. Keep these three blocks adjacent
      // and in this order.
      try {
        const { drainInferQueue, runAllExtractors } = await import("./services/relationships/orchestrator");
        const drained = await drainInferQueue(env, 200);
        const full = await runAllExtractors(env, {});
        console.log("relationship inference done", JSON.stringify({ drained, full_total_edges: full.total_edges, duration_ms: full.duration_ms }));
      } catch (e) {
        await logError(env, { err: e, step: "nightly relationship inference" });
        console.error("nightly relationship inference failed", (e as Error).message);
      }

      // Task #3: Edge-Quality Scoring + Power-Node Detection.
      // Re-scores every rel_edges row from the 8 public signals
      // (capped at 5000 edges/tick) and rebuilds entity_influence
      // with global + per-sector PageRank and broker scores. Piggybacks
      // the consolidated nightly slot per the Free-plan cron cap
      // (see Task #4 angel-sweep / Task #14 verification / Task #18
      // benchmarks notes).
      try {
        const { runEdgeQualitySweep } = await import("./services/edgeQuality/sweep");
        const r = await runEdgeQualitySweep(env);
        console.log("edge quality sweep done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "nightly edge quality sweep" });
        console.error("nightly edge quality sweep failed", (e as Error).message);
      }

      // Task #4 (Intro Routing Engine): nightly retrain of the logistic
      // conversion model from intro_outcomes. No-op until at least
      // MIN_TRAIN_SAMPLES (25) labeled outcomes exist; persists one
      // immutable row in intro_model_runs and flips is_current. Cheap
      // (single pass over recent outcomes), piggybacks the consolidated
      // nightly slot per the Free-plan cron cap.
      try {
        const { runNightlyIntroRetrain } = await import("./services/intros/train");
        const r = await runNightlyIntroRetrain(env);
        console.log("intro retrain done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "nightly intro retrain" });
        console.error("nightly intro retrain failed", (e as Error).message);
      }

      // Task #5: nightly investor-reputation recompute. Bounded at
      // 1000 investors/tick. Piggybacks the consolidated nightly slot
      // (Free plan caps crons at 5/5 — same constraint as Task #4
      // angel sweep, Task #14 verification, Task #18 benchmarks,
      // Task #2 fund returns, Task #3 edge quality, Task #4 intro
      // retrain). Per-investor recompute is also triggered inline on
      // POST /api/founder-feedback for the affected investor.
      try {
        const { runNightlyReputationSweep } = await import("./services/founderCrm/reputation");
        const r = await runNightlyReputationSweep(env, 1000);
        console.log("nightly investor reputation sweep done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "nightly investor reputation sweep" });
        console.error("nightly investor reputation sweep failed", (e as Error).message);
      }

      // Task #1: Garbage Entity Detector — cron sweep over entities
      // created in the recent window. Piggybacks the consolidated
      // nightly slot (Free plan caps crons at 5/5 — see Task #4
      // angel sweep / Task #14 verification / Task #18 benchmarks /
      // Task #2 fund returns / Task #3 edge quality / Task #4 intro
      // retrain / Task #5 reputation precedent). Bounded at 5000
      // entities/tick. Soft-deletes flagged rows (never hard-delete);
      // operators audit + restore via /ops/garbage-review/.
      try {
        const { runCleanupSweep } = await import("./entities/garbage");
        // Nightly cadence + 30h lookback (>24h to cover the daily run
        // plus the structural-orphan ≥24h-old rule).
        const r = await runCleanupSweep(env, { mode: "recent", lookbackHours: 30, limit: 5000, source: "cron_sweep" });
        console.log("garbage sweep done", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "nightly garbage sweep" });
        console.error("nightly garbage sweep failed", (e as Error).message);
      }

      // Task #9: External Worker Pool watchdog. Cheap (single SELECT +
      // small UPDATEs). Marks compute_nodes with no fresh heartbeat
      // (>90s) disabled, reassigns their open assignments, and
      // times out any deadline-elapsed in-flight rows. Piggybacks
      // dispatcher invocations + this nightly slot — no new cron
      // (Free plan caps crons at 5/5; same constraint as Task #4
      // angel sweep / Task #14 verification / Task #18 benchmarks /
      // Task #2 fund returns / Task #3 edge quality / Task #4 intro
      // retrain / Task #5 reputation / Task #1 garbage sweep).
      try {
        const { runComputeWatchdog } = await import("./services/compute/dispatcher");
        const r = await runComputeWatchdog(env);
        if (r.nodes_disabled || r.assignments_reassigned || r.assignments_timed_out) {
          console.log("compute watchdog done", JSON.stringify(r));
        }
      } catch (e) {
        await logError(env, { err: e, step: "nightly compute watchdog" });
        console.error("nightly compute watchdog failed", (e as Error).message);
      }

      // 5. Project match refresh
      try {
        const r = await env.DB.prepare(`SELECT id FROM projects WHERE deleted_at IS NULL AND status = 'active' ORDER BY last_modified DESC LIMIT 200`).all<{ id: string }>();
        for (const row of r.results ?? []) {
          if (env.WF_MATCH_PROJECT) {
            try { await env.WF_MATCH_PROJECT.create({ params: { projectId: row.id } }); }
            catch (e) { console.warn("nightly WF_MATCH_PROJECT.create failed", row.id, (e as Error).message); }
          } else {
            const { runAudienceMatching } = await import("./services/projects/audienceMatcher");
            try { await runAudienceMatching(env, row.id); }
            catch (e) { console.warn("nightly runAudienceMatching failed", row.id, (e as Error).message); }
          }
        }
      } catch (e) {
        await logError(env, { err: e, step: "nightly project match refresh" });
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
        const { markCronTick } = await import("./services/systemHealth/snapshot");
        await markCronTick(env, "30 4 * * *");
      } catch (e) {
        await logError(env, { err: e, step: "daily 04:30 markCronTick" });
      }
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
        await logError(env, { err: e, step: "refresh-saved-research" });
        console.error("refresh-saved-research failed", (e as Error).message);
      }
    })());
    return;
  }
  if (event && (event as ScheduledEvent).cron === "0 4 * * *") {
    ctx.waitUntil((async () => {
      try {
        const { markCronTick } = await import("./services/systemHealth/snapshot");
        await markCronTick(env, "0 4 * * *");
      } catch (e) {
        await logError(env, { err: e, step: "daily 04:00 markCronTick" });
      }
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
        await logError(env, { err: e, step: "daily dd-scan-batch" });
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
        await logError(env, { err: e, step: "nightly news refresh batch" });
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
        await logError(env, { err: e, step: "nightly classify-batch" });
        console.error("nightly classify-batch failed", (e as Error).message);
      }
      // Task #3 (this task): nightly AI Profile Filler — picks the 200
      // stalest entities (no `ai_profile_filled_at` fact, oldest first)
      // and fills each. Bounded so a single tick fits inside the
      // shared AI_DAILY_NEURONS_CAP.
      try {
        if (env.WF_PROFILE_FILLER_BATCH) {
          await env.WF_PROFILE_FILLER_BATCH.create({ params: { limit: 200 } });
          console.log("ai-profile-filler-batch workflow dispatched");
        } else {
          const { fillStalestBatch } = await import("./ai/profileFiller");
          const r = await fillStalestBatch(env, { limit: 50 });
          console.log("ai-profile-filler-batch inline", JSON.stringify(r));
        }
      } catch (e) {
        await logError(env, { err: e, step: "nightly ai-profile-filler-batch" });
        console.error("nightly ai-profile-filler-batch failed", (e as Error).message);
      }
      // Nightly person-profiler sweep. Until now `runProfiler` had no
      // scheduler at all — it ran only when an operator hit POST
      // /api/profilers/:entity_id/run — so career_history,
      // education_history and board_seats filled one hand-clicked person
      // at a time. Six of the thirteen relationship-edge extractors read
      // exactly those tables, which is a large part of why `rel_edges`
      // (and therefore Power Nodes) is empty.
      //
      // The batch dispatches Workflow instances, so the runs it starts
      // complete after this tick has moved on; the edges they enable are
      // extracted on the following night's pass. Running the profiler
      // inline to close that gap would mean up to 60 s of wall-clock per
      // entity inside a slot that already carries ~38 sweeps.
      try {
        const { runStalestProfilerBatch } = await import("./services/profilers/batch");
        const r = await runStalestProfilerBatch(env, { limit: 25 });
        console.log("nightly profiler-batch", JSON.stringify(r));
      } catch (e) {
        // No console.error here: the logError above is the durable record,
        // and this file is the one the gate could not see (see the pathspec
        // note in .github/workflows/check.yml). The 70 other console.error
        // calls in this file predate the fix and are grandfathered by the
        // gate's added-lines-only scan; new ones are not.
        await logError(env, { err: e, step: "nightly profiler-batch" });
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
        await logError(env, { err: e, step: "nightly osint-batch" });
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
        await logError(env, { err: e, step: "nightly osint-reverify" });
        console.error("nightly osint-reverify failed", (e as Error).message);
      }
      // Task #7: identity backfill — promote scraped social/website facts
      // into identity_handles for persons crawled before the harvest+promote
      // wiring landed. Bounded so it fits inside this shared tick.
      try {
        const { runIdentityBackfill } = await import("./services/identity/backfill");
        const r = await runIdentityBackfill(env, { limit: 50 });
        console.log("identity-backfill inline", JSON.stringify(r));
      } catch (e) {
        await logError(env, { err: e, step: "nightly identity-backfill" });
        console.error("nightly identity-backfill failed", (e as Error).message);
      }
      // Task #13: geo backfill — resolve firms.hq_country_iso2 left NULL by
      // pre-resolution scrapes (from notes hq_country_name / hq_region /
      // website ccTLD). Idempotent; bounded so it fits this shared tick.
      try {
        const { runFirmGeoBackfill } = await import("./scraper/geo_backfill");
        const r = await runFirmGeoBackfill(env, { limit: 1000 });
        console.log("firm-geo-backfill inline", JSON.stringify(r));
        // Re-materialize the firm geo aggregate so newly-resolved codes are
        // visible immediately — the geo endpoint prefers the materialized
        // payload, and this backfill runs on a different cron branch than the
        // nightly analytics aggregator. Only worth it when something changed.
        if (r.resolved > 0) {
          const { materializeFirmAnalytics } = await import("./routes/analytics_firms");
          await materializeFirmAnalytics(env);
        }
      } catch (e) {
        await logError(env, { err: e, step: "nightly firm-geo-backfill" });
        console.error("nightly firm-geo-backfill failed", (e as Error).message);
      }
    })());
    return;
  }
  // Task #5: every 6h, the registry is the source of truth. We enqueue
  // a firmlist job for every enabled row whose `next_run_after` has
  // passed (or is null) — capped at 200/tick so a single cron tick
  // doesn't melt the queue. On first deploy, populate the registry
  // from seed-sources.json so it isn't empty.
  // Both candidate selects are wrapped: an unhandled throw here (missing
  // table on a fresh DB, transient D1 error) used to reject the whole
  // scheduled() call and skip all three 6-hourly sweeps.
  let registryRows: SourceRow[] = [];
  try {
    const registryDue = await env.DB.prepare(
      `SELECT * FROM source_registry
         WHERE enabled = 1
           AND last_run_status != 'running'
           AND (next_run_after IS NULL OR datetime(next_run_after) <= datetime('now'))
         ORDER BY COALESCE(next_run_after, added_at) ASC LIMIT 200`,
    ).all<SourceRow>();
    registryRows = registryDue.results ?? [];
  } catch (e) {
    await logError(env, { err: e, step: "6h source_registry select" });
  }

  const enqueueRegistry = async () => {
    if (registryRows.length === 0) {
      // First-deploy bootstrap: registry is empty, populate from seeds.
      const probe = await env.DB.prepare(`SELECT COUNT(*) AS n FROM source_registry`).first<{ n: number }>();
      if (!probe || probe.n === 0) {
        try {
          const r = await loadSeedSources(env);
          console.log("source_registry first-deploy bootstrap", JSON.stringify(r));
        } catch (e) {
          await logError(env, { err: e, step: "source_registry bootstrap" });
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
  let rows: LegacySourceRow[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT id, domain FROM sources
         WHERE enabled = 1
           AND (last_scraped_at IS NULL OR datetime(last_scraped_at) < datetime('now','-24 hours'))
         LIMIT 200`,
    ).all<LegacySourceRow>();
    rows = r.results ?? [];
  } catch (e) {
    await logError(env, { err: e, step: "6h legacy sources select" });
  }

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
    // Task #54: select the FULL lead rows in this one query and hand each to
    // enrichLead via preloadedLead, so the orchestrator skips its own
    // per-lead getById (was a 500× N+1 read on top of this selection).
    const stale = await env.DB
      .prepare(
        `SELECT * FROM leads
           WHERE merged_into IS NULL
             AND (
               (priority IN ('p0','p1') AND (last_enriched_at IS NULL OR datetime(last_enriched_at) < datetime('now','-7 days')))
               OR
               (last_enriched_at IS NULL OR datetime(last_enriched_at) < datetime('now','-30 days'))
             )
           ORDER BY (last_enriched_at IS NULL) DESC, last_enriched_at ASC
           LIMIT 500`,
      )
      .all<Lead>();
    for (const lead of stale.results ?? []) {
      try {
        await enrichLead(env, lead.id, { preloadedLead: lead });
      } catch (e) {
        console.warn("scheduled enrich failed", lead.id, (e as Error).message);
      }
    }
  };

  // Task #5 cron-status panel: mark this slot too (only the hourly and
  // nightly slots were marked, so the panel showed the 6-hourly cron as
  // never having run).
  ctx.waitUntil((async () => {
    const { markCronTick } = await import("./services/systemHealth/snapshot");
    await markCronTick(env, "0 */6 * * *");
  })().catch((e) => logError(env, { err: e, step: "6h markCronTick" })));
  ctx.waitUntil(enqueueRegistry().catch((e) => logError(env, { err: e, step: "6h enqueueRegistry" })));
  ctx.waitUntil(enqueueScrapes().catch((e) => logError(env, { err: e, step: "6h enqueueScrapes" })));
  ctx.waitUntil(reEnrichStale().catch((e) => logError(env, { err: e, step: "6h reEnrichStale" })));
}
