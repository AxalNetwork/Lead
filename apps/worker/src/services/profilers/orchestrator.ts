// Task #5 step 9: orchestrator.
//
// Loads entity, computes privacy, fans out enrichers in parallel via
// Promise.allSettled (the Workflow wraps each individual call in
// step.do so they survive instance restarts). Per-enricher 25 s
// wall-clock cap, partial results persist on timeout. One failed
// enricher never poisons the rest.

import type { Env } from "../../types";
import { applyWrites } from "./applyWrites";
import { computePrivacy } from "./privacy";
import { clearLastRun } from "./rateLimit";
import { ALL_ENRICHERS } from "./registry";
import { synthesize } from "./synthesize";
import type { Enricher, EnricherContext, EnricherResult } from "./types";

const PER_ENRICHER_MS = 25_000;

export interface RunOpts {
  runId: string;
  triggeredBy: string;
  forceRefresh?: boolean;
  /**
   * Viewer entity id. The orchestrator no longer threads this into
   * persisted synthesis — viewer-specific warm-intro paths are computed
   * at read time by routes/profilers.ts /dossier. Kept here for log
   * traceability only.
   */
  viewerEntityId?: string | null;
  /** When set, skip enrichers whose `name` is NOT in this list. Used by
   *  tests + per-enricher re-runs. */
  onlyEnrichers?: string[];
  /**
   * Optional per-enricher step wrapper. The Cloudflare Workflow class
   * (ai/workflows.ts IndividualProfilerWorkflow) passes
   * `(name, fn) => step.do(name, ..., fn)` so every enricher becomes a
   * durable workflow step that can be retried / resumed across instance
   * restarts. When omitted (route's waitUntil fallback, tests) the
   * runner is the identity function so behavior is unchanged.
   */
  stepRunner?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface RunSummary {
  runId: string;
  entityId: string;
  status: "succeeded" | "partial" | "failed" | "privacy_skip";
  respects_privacy: boolean;
  privacy_reasons: string[];
  enricher_count: number;
  writes_count: number;
  failed_count: number;
  skipped_count: number;
  total_wall_ms: number;
  total_est_usd: number;
  total_neurons: number;
  synthesis_id: string | null;
}

interface EntityRow {
  id: string; display_name: string | null; primary_url: string | null;
  primary_domain: string | null; primary_linkedin_key: string | null;
  primary_twitter_handle: string | null; primary_github_handle: string | null;
  kind: string;
}

export async function runProfiler(env: Env, entityId: string, opts: RunOpts): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // 0. Load entity. On early failure we MUST clear the KV rate-limit key
  //    the route set proactively — otherwise a never-started run would
  //    block the entity for 7 days.
  const entity = await env.DB.prepare(
    `SELECT id, kind, display_name, primary_url, primary_domain,
            primary_linkedin_key, primary_twitter_handle, primary_github_handle
       FROM u_entities WHERE id = ? LIMIT 1`,
  ).bind(entityId).first<EntityRow>();
  if (!entity) {
    await clearLastRun(env, entityId);
    throw new Error(`profiler: entity ${entityId} not found`);
  }
  if (entity.kind !== "person") {
    await clearLastRun(env, entityId);
    throw new Error(`profiler: entity ${entityId} kind=${entity.kind} (person required)`);
  }

  // 1. Privacy gate.
  const privacy = await computePrivacy(env, entityId);

  // 2. Write run header. The route may have already INSERTed a 'queued'
  //    header so the workflow_run_id update from dispatch lands on a
  //    real row (eliminates the dispatch-vs-orchestrator race). We
  //    UPSERT here: insert if absent, otherwise transition queued →
  //    running and fill in the privacy fields the route can't know yet.
  await env.DB.prepare(
    `INSERT INTO profiler_runs
       (id, entity_id, workflow_run_id, status, triggered_by, force_refresh,
        respects_privacy, privacy_reasons_json, enricher_count, started_at)
       VALUES (?, ?, NULL, 'running', ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = 'running',
       respects_privacy = excluded.respects_privacy,
       privacy_reasons_json = excluded.privacy_reasons_json,
       started_at = excluded.started_at`,
  ).bind(
    opts.runId, entityId, opts.triggeredBy, opts.forceRefresh ? 1 : 0,
    privacy.respects_privacy ? 1 : 0, JSON.stringify(privacy.reasons), startedAt,
  ).run();

  // 3. Pick enrichers.
  const candidates = ALL_ENRICHERS
    .filter((e) => !opts.onlyEnrichers || opts.onlyEnrichers.includes(e.name))
    .filter((e) => !(privacy.respects_privacy && e.respectsPrivacy));

  // Tracking buckets.
  const ctx: EnricherContext = {
    runId: opts.runId, startedAt, deadlineEpochMs: startMs + 60_000,
    privacy,
    entity: {
      id: entity.id, display_name: entity.display_name,
      primary_url: entity.primary_url, primary_domain: entity.primary_domain,
      primary_linkedin_key: entity.primary_linkedin_key,
      primary_twitter_handle: entity.primary_twitter_handle,
      primary_github_handle: entity.primary_github_handle,
    },
  };

  // 4. Run enrichers in parallel — each wrapped so one failure can't
  //    poison the batch and each has its own wall-clock cap. When
  //    invoked from the Cloudflare Workflow each enricher is also
  //    wrapped in step.do for durable per-enricher resumption.
  const runStep = opts.stepRunner ?? (async (_n, fn) => fn());
  const results = await Promise.allSettled(candidates.map((e) =>
    runStep(`enricher:${e.name}`, () => runOneEnricher(env, e, entityId, ctx)),
  ));

  // Also persist hard-skip logs for privacy-gated enrichers we excluded
  // so the status endpoint reports them as `skipped`.
  if (privacy.respects_privacy) {
    const excluded = ALL_ENRICHERS.filter((e) => e.respectsPrivacy);
    for (const e of excluded) {
      await logEnricher(env, opts.runId, entityId, e, {
        status: "skipped", skippedReason: "privacy_gate", writesCount: 0,
        cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: 0, est_usd: 0 },
        startedAt, finishedAt: new Date().toISOString(),
      });
    }
  }

  // 5. Aggregate totals.
  let total_writes = 0, failed_count = 0, skipped_count = 0, total_neurons = 0;
  let total_est_usd = 0, total_wall_ms = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const e = candidates[i];
    if (r.status === "rejected") {
      failed_count += 1;
      await logEnricher(env, opts.runId, entityId, e, {
        status: "failed", error: String(r.reason).slice(0, 500), writesCount: 0,
        cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: 0, est_usd: 0 },
        startedAt, finishedAt: new Date().toISOString(),
      });
      continue;
    }
    const er = r.value;
    if (er.skipped) skipped_count += 1;
    if (er.error) failed_count += 1;
    total_writes += er.writes.length;
    total_neurons += er.cost.neurons;
    total_est_usd += er.cost.est_usd;
    total_wall_ms += er.cost.wall_ms;
  }

  // 6. Synthesis — runs even for privacy-skipped people (with limited
  //    data they may still have public bios → conversation starters).
  //    Note: viewer is intentionally NOT passed — viewer-specific
  //    warm-intro paths are computed at /dossier read time so persisted
  //    state stays stable per-entity. Also wrapped in step.do when
  //    available so synthesis re-runs cleanly on instance restart.
  let synthesisId: string | null = null;
  try {
    const s = await runStep("synthesize", () => synthesize(env, entityId, { runId: opts.runId }));
    synthesisId = s.synthesisId;
  } catch (e) {
    failed_count += 1;
    console.warn("profiler.synthesize failed", entityId, (e as Error).message);
  }

  // 7. Final status update.
  const finishedAt = new Date().toISOString();
  const status: RunSummary["status"] = privacy.respects_privacy && total_writes === 0
    ? "privacy_skip"
    : failed_count > 0 && total_writes === 0 ? "failed"
    : failed_count > 0 ? "partial" : "succeeded";

  await env.DB.prepare(
    `UPDATE profiler_runs
        SET status = ?, enricher_count = ?, writes_count = ?, failed_count = ?,
            skipped_count = ?, total_neurons = ?, total_est_usd = ?,
            total_wall_ms = ?, finished_at = ?
      WHERE id = ?`,
  ).bind(
    status, candidates.length, total_writes, failed_count, skipped_count,
    total_neurons, total_est_usd, total_wall_ms, finishedAt, opts.runId,
  ).run();

  return {
    runId: opts.runId, entityId, status,
    respects_privacy: privacy.respects_privacy, privacy_reasons: privacy.reasons,
    enricher_count: candidates.length, writes_count: total_writes, failed_count,
    skipped_count, total_wall_ms, total_est_usd, total_neurons,
    synthesis_id: synthesisId,
  };
}

async function runOneEnricher(
  env: Env, e: Enricher, entityId: string, ctx: EnricherContext,
): Promise<EnricherResult> {
  const startedAt = new Date().toISOString();
  // Insert pending log immediately so status endpoint can show it.
  await logEnricher(env, ctx.runId, entityId, e, {
    status: "running", writesCount: 0,
    cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: 0, est_usd: 0 },
    startedAt, finishedAt: null,
  });

  const t0 = Date.now();
  let result: EnricherResult;
  // The loser of the race has to be cancelled. Without this, every
  // enricher that finishes quickly still leaves a live 25 s timer behind
  // — ~38 of them per profiler run — which keeps the isolate's event loop
  // occupied long after the run is done, and holds `node --test` open for
  // a full 25 s after the last assertion.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 25 s wall-clock cap (task contract).
    result = await Promise.race<EnricherResult>([
      e.run(env, entityId, ctx),
      new Promise<EnricherResult>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("enricher_timeout_25s")), PER_ENRICHER_MS);
      }),
    ]);
  } catch (err) {
    const wall_ms = Date.now() - t0;
    await logEnricher(env, ctx.runId, entityId, e, {
      status: "failed", error: (err as Error).message.slice(0, 500),
      writesCount: 0,
      cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms, est_usd: 0 },
      startedAt, finishedAt: new Date().toISOString(),
    });
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // Apply writes via EntityService helpers.
  let appliedCount = 0;
  let writeErrors: string[] = [];
  if (result.writes.length > 0 && !result.skipped) {
    const applied = await applyWrites(env, result.writes);
    appliedCount = applied.applied;
    writeErrors = applied.errors;
  }

  const finishedAt = new Date().toISOString();
  // If any write failed, the enricher is considered failed (not just
  // logged) so run-level aggregates reflect it — otherwise we'd report
  // `succeeded` while structured writes silently dropped on the floor.
  const writeFailed = writeErrors.length > 0;
  await logEnricher(env, ctx.runId, entityId, e, {
    status: result.skipped ? "skipped" : writeFailed ? "failed" : "done",
    skippedReason: result.skipped?.reason,
    error: writeFailed ? writeErrors.join("; ").slice(0, 500) : undefined,
    writesCount: appliedCount,
    cost: result.cost, startedAt, finishedAt,
  });

  // Propagate the error onto the returned result so the orchestrator's
  // aggregate loop counts this enricher in `failed_count` and adjusts
  // the run status to `partial` or `failed`.
  if (writeFailed && !result.error) {
    return { ...result, error: `apply_writes_failed: ${writeErrors.join("; ").slice(0, 240)}` };
  }
  return result;
}

interface LogPayload {
  status: "pending" | "running" | "done" | "skipped" | "failed";
  skippedReason?: string;
  error?: string;
  writesCount: number;
  cost: { neurons: number; fetches: number; bytes: number; wall_ms: number; est_usd: number };
  startedAt: string;
  finishedAt: string | null;
}

async function logEnricher(
  env: Env, runId: string, entityId: string, e: Enricher, p: LogPayload,
): Promise<void> {
  // UPSERT keyed on (run_id, enricher_name) so a "running" row gets
  // updated to "done" / "failed" in place rather than producing two rows.
  try {
    await env.DB.prepare(
      `INSERT INTO profiler_enricher_logs
         (id, run_id, entity_id, enricher_name, category, status,
          skipped_reason, error, writes_count, neurons, fetches, bytes,
          wall_ms, est_usd, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, enricher_name) DO UPDATE SET
           status = excluded.status,
           skipped_reason = excluded.skipped_reason,
           error = excluded.error,
           writes_count = excluded.writes_count,
           neurons = excluded.neurons,
           fetches = excluded.fetches,
           bytes = excluded.bytes,
           wall_ms = excluded.wall_ms,
           est_usd = excluded.est_usd,
           finished_at = excluded.finished_at`,
    ).bind(
      crypto.randomUUID(), runId, entityId, e.name, e.category, p.status,
      p.skippedReason ?? null, p.error ?? null, p.writesCount,
      p.cost.neurons, p.cost.fetches, p.cost.bytes, p.cost.wall_ms, p.cost.est_usd,
      p.startedAt, p.finishedAt,
    ).run();
  } catch (err) {
    console.warn("profiler.logEnricher failed", e.name, (err as Error).message);
  }
}
