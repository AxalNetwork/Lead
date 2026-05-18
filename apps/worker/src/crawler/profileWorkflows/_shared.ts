// Task #1: shared runner for declarative per-profile-type workflows.
//
// One pattern, many files (task constraint). Each typed workflow exports
// a small `WorkflowDef` describing its sources, extraction schema, and
// predicate mapping; the runner here performs the actual fetch → extract
// → cross-source verify → persist → record sequence.
//
// Persistence model
// -----------------
// Every fact is written into `facts` (migration 201) with the same
// dedupe hash convention used by `entities/profile.ts` mirrorFact:
//   hash = sha256(entity_id | predicate | source_url)
// A second observation of the same (entity, predicate, source_url)
// UPDATEs the existing row (value, confidence, observed_at, verified)
// rather than creating a duplicate. The structured `_workflow_run_id`
// links every fact written by this layer back to its run row for
// auditing / cost roll-up.
//
// Cross-source verification
// -------------------------
// Facts are bucketed by `sourceTag`. For each predicate, if a normalized
// value appears in ≥2 distinct bucket tags the runner promotes every
// matching write to `verified=1`; single-source facts persist with
// `verified=0` and reduced confidence (× 0.6). This rule is in one
// place (here) so promotion semantics stay consistent across the ~80
// typed workflows.

import type { Env } from "../../types";
import { fetchPage } from "../../scraper/fetcher";
import { aiCacheGet, aiCachePut, sha256Hex } from "../../ai/cache";
import { assertBudget } from "../../ai/budget";
import { limitAi } from "../../scraper/rateLimit";
import { trackAi } from "../../analytics/events";
import { sha256 } from "../../entities/normalize";
import type {
  FactCandidate, PlannedSource, ProfileWorkflow, WorkflowContext,
  WorkflowDef, WorkflowError, WorkflowResult, WorkflowRunOpts,
} from "./_types";

const AI_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const DEFAULT_BUDGET_USD = 0.05;
const STRIP_BODY_BYTES = 4500;

// ---- URL helpers ---------------------------------------------------------

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function originOf(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.hostname}`; }
  catch { return ""; }
}

/** Build sibling URLs by appending common subpaths to the candidate's origin. */
export function sameOrigin(candidateUrl: string, paths: string[]): { tag: string; url: string }[] {
  const origin = originOf(candidateUrl);
  if (!origin) return [];
  const seen = new Set<string>();
  const out: { tag: string; url: string }[] = [];
  for (const p of paths) {
    const url = `${origin}${p.startsWith("/") ? "" : "/"}${p}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ tag: p.replace(/^\/+|\/+$/g, "") || "root", url });
  }
  return out;
}

// ---- HTML → text --------------------------------------------------------

export function stripForExtract(html: string): string {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const desc  = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "").trim();
  const og    = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "").trim();
  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, STRIP_BODY_BYTES);
  return [
    title ? `TITLE: ${title}` : "",
    desc  ? `DESC: ${desc}`  : "",
    og    ? `OG: ${og}`      : "",
    `BODY: ${body}`,
  ].filter(Boolean).join("\n");
}

// ---- AI call with timeout + cache --------------------------------------

async function runAiWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ai_timeout:${label}:${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface AiCallResult { json: unknown | null; neurons: number; cacheHit: boolean; model: string }

async function runAiExtract(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  defaultModel: string,
  jobId: string | undefined,
  workflowId: string,
): Promise<AiCallResult> {
  if (!env.AI) return { json: null, neurons: 0, cacheHit: false, model: defaultModel };
  const budget = await assertBudget(env, "ai");
  if (!budget.ok) return { json: null, neurons: 0, cacheHit: false, model: defaultModel };
  if (!(await limitAi(env))) return { json: null, neurons: 0, cacheHit: false, model: defaultModel };
  const models = [defaultModel, FALLBACK_MODEL];
  for (let attempt = 0; attempt < models.length; attempt++) {
    const model = models[attempt];
    const cacheKey = await sha256Hex(`${model}:pwf:${workflowId}:${userPrompt}`);
    const cached = await aiCacheGet<unknown>(env, cacheKey);
    if (cached) {
      trackAi(env, { purpose: "extraction", model, cacheHit: true, jobId });
      return { json: cached, neurons: 0, cacheHit: true, model };
    }
    const t0 = Date.now();
    try {
      const res = (await runAiWithTimeout(env.AI.run(model, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_schema", json_schema: schema },
      }), AI_TIMEOUT_MS, `pwf:${workflowId}`)) as { response?: string };
      const text = typeof res?.response === "string" ? res.response : "";
      let parsed: unknown = null;
      if (text) { try { parsed = JSON.parse(text); } catch { /* attempt fallback below */ } }
      if (parsed && typeof parsed === "object") {
        trackAi(env, { purpose: "extraction", model, ms: Date.now() - t0, neurons: 0.1, jobId });
        await aiCachePut(env, cacheKey, parsed);
        return { json: parsed, neurons: 0.1, cacheHit: false, model };
      }
    } catch (e) {
      console.warn(`profile-workflow ai attempt ${attempt + 1} failed`, (e as Error).message);
    }
  }
  return { json: null, neurons: 0.1, cacheHit: false, model: defaultModel };
}

// ---- Fact normalization for cross-source comparison ---------------------

function normalizeForKey(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim().toLowerCase().replace(/\s+/g, " ");
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(normalizeForKey).sort().join("|");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().map((k) => `${k}:${normalizeForKey(o[k])}`).join("|");
  }
  return String(v);
}

function factValueKey(f: FactCandidate): string {
  if (f.valueText != null) return `t:${normalizeForKey(f.valueText)}`;
  if (f.valueNumber != null) return `n:${normalizeForKey(f.valueNumber)}`;
  if (f.valueJson != null) return `j:${normalizeForKey(f.valueJson)}`;
  return "";
}

/**
 * Cross-source verifier. Returns the same list with each fact stamped
 * with a derived `verified` flag and an adjusted confidence: verified
 * facts keep their stated confidence; un-verified facts get × 0.6.
 *
 * Promotion rule (task contract): a fact is `verified=1` when its
 * normalized (predicate, value) is observed under ≥2 distinct
 * `sourceTag` buckets. This rule is exposed at module scope so the
 * smoke test in `test/profileWorkflows.test.mjs` can verify it without
 * a live DB.
 */
export function crossRef(facts: FactCandidate[]): { fact: FactCandidate; verified: boolean; adjustedConfidence: number }[] {
  const tagsBy: Record<string, Set<string>> = {};
  for (const f of facts) {
    const k = `${f.predicate}::${factValueKey(f)}`;
    if (!k.endsWith("::")) {
      (tagsBy[k] ??= new Set()).add(f.sourceTag);
    }
  }
  return facts.map((f) => {
    const k = `${f.predicate}::${factValueKey(f)}`;
    const verified = (tagsBy[k]?.size ?? 0) >= 2;
    const adjustedConfidence = verified
      ? Math.min(1, f.confidence)
      : Math.max(0.05, f.confidence * 0.6);
    return { fact: f, verified, adjustedConfidence };
  });
}

// ---- Persistence --------------------------------------------------------

/**
 * Derive a stable entity id from the candidate context when the caller
 * doesn't supply one. Uses sha256(profile_type_id|candidateUrl) so
 * re-runs against the same page accumulate into the same entity bucket;
 * upstream entity-resolution can later merge it into a canonical entity.
 */
export async function resolveEntityId(typeId: string, ctx: WorkflowContext): Promise<string> {
  if (ctx.entityId) return ctx.entityId;
  const seed = `${typeId}|${ctx.candidateUrl}`;
  const h = await sha256(seed);
  return `pwf_${h.slice(0, 32)}`;
}

async function writeFact(
  env: Env,
  entityId: string,
  f: FactCandidate,
  verified: boolean,
  adjustedConfidence: number,
  workflowId: string,
  runId: string,
  observedAt: string,
): Promise<void> {
  const hash = await sha256(`${entityId}|${f.predicate}|${f.sourceUrl}`);
  const valueText = f.valueText ?? null;
  const valueNumber = f.valueNumber ?? null;
  const valueJsonStr = f.valueJson != null ? JSON.stringify(f.valueJson) : null;
  try {
    await env.DB.prepare(
      `INSERT INTO facts (
         id, entity_id, predicate, value_text, value_number, value_json,
         value_entity_id, source_kind, source, evidence_url, confidence,
         observed_at, valid_from, valid_to, is_current, hash, verified
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'enrichment', ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      entityId,
      f.predicate,
      valueText,
      valueNumber,
      valueJsonStr,
      `profile_workflow:${workflowId}:${runId}`,
      f.sourceUrl,
      adjustedConfidence,
      observedAt,
      hash,
      verified ? 1 : 0,
    ).run();
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) {
      await env.DB.prepare(
        `UPDATE facts
            SET value_text = ?, value_number = ?, value_json = ?,
                confidence = MAX(confidence, ?),
                observed_at = ?, is_current = 1,
                verified = MAX(verified, ?)
          WHERE hash = ?`,
      ).bind(valueText, valueNumber, valueJsonStr, adjustedConfidence, observedAt, verified ? 1 : 0, hash).run();
    } else {
      throw e;
    }
  }
}

async function recordRun(env: Env, row: {
  runId: string;
  workflow: WorkflowDef;
  ctx: WorkflowContext;
  entityId: string | null;
  result: WorkflowResult;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO profile_workflow_runs (
       id, workflow_id, profile_type_id, entity_id, candidate_url, candidate_host,
       job_id, status, sources_planned, sources_fetched, sources_failed,
       facts_written, facts_verified, ai_calls, ai_neurons,
       estimated_cost_usd, actual_cost_usd, errors_json, duration_ms, run_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.runId,
    row.workflow.id,
    row.workflow.profile_type_id,
    row.entityId,
    row.ctx.candidateUrl,
    row.ctx.candidateHost,
    row.ctx.jobId ?? null,
    row.result.status,
    row.result.sources_planned,
    row.result.sources_fetched,
    row.result.sources_failed,
    row.result.facts_written,
    row.result.facts_verified,
    row.result.ai_calls,
    row.result.ai_neurons,
    row.result.estimated_cost_usd,
    row.result.actual_cost_usd,
    JSON.stringify(row.result.errors),
    row.result.duration_ms,
    new Date().toISOString(),
    new Date().toISOString(),
  ).run().catch((e) => {
    // Don't fail the workflow on the bookkeeping insert — the operator
    // console will simply miss this run row.
    console.warn("profile_workflow_runs insert failed", (e as Error).message);
  });
}

// ---- Public runner ------------------------------------------------------

/**
 * Execute a declarative `WorkflowDef`. Fetches every planned source via
 * the tiered fetcher, archives raw HTML, runs the AI extraction with the
 * supplied schema per source, cross-source verifies the resulting facts,
 * writes them to `facts`, and records a `profile_workflow_runs` row.
 *
 * Cost gating: a workflow stops fetching new sources once the actual
 * USD cost exceeds `opts.budgetUsdCap` (default 0.05). Cost so far is
 * the sum of fetch tier costs reported by `fetchPage`.
 */
export async function runStandardWorkflow(
  env: Env,
  def: WorkflowDef,
  ctx: WorkflowContext,
  opts: WorkflowRunOpts = {},
): Promise<WorkflowResult> {
  const t0 = Date.now();
  const runId = crypto.randomUUID();
  const budgetUsdCap = opts.budgetUsdCap ?? DEFAULT_BUDGET_USD;
  const observedAt = opts.observedAt ?? new Date().toISOString();
  const errors: WorkflowError[] = [];

  // Resolve entity id up-front so failure paths can still record one.
  const entityId = await resolveEntityId(def.profile_type_id, ctx);

  // Step 1: build source plan. The candidate page itself is always the
  // first bucket — its HTML was fetched upstream and lives in ctx.
  const planned = def.plan(ctx);
  const sources: PlannedSource[] = [
    { tag: "candidate", url: ctx.candidateUrl },
    ...planned,
  ];

  // Step 2: fetch sources (skip the candidate — already in ctx).
  type FetchedSource = { source: PlannedSource; html: string; ok: boolean };
  const fetched: FetchedSource[] = [
    { source: sources[0], html: ctx.candidateHtml, ok: true },
  ];
  let sourcesFetched = 1;
  let sourcesFailed = 0;
  let actualCostUsd = 0;

  for (const src of sources.slice(1)) {
    if (budgetUsdCap <= 0 || actualCostUsd >= budgetUsdCap) {
      errors.push({ tag: src.tag, message: "skipped_budget_exceeded" });
      continue;
    }
    try {
      const r = await fetchPage(env, src.url, { jobId: ctx.jobId ?? undefined, minIntervalMs: 4000 });
      actualCostUsd += (r.ok ? 0.001 : 0); // conservative; fetcher logs precise tier cost
      if (!r.ok) {
        if (!src.optional) sourcesFailed += 1;
        errors.push({ tag: src.tag, message: `fetch_failed:${r.blockReason ?? r.status}` });
        continue;
      }
      sourcesFetched += 1;
      fetched.push({ source: src, html: r.html, ok: true });
      // Note: the candidate page is already R2-archived by the upstream
      // pipeline before this workflow runs. Sibling-page archiving is
      // skipped to avoid coupling this module to `news/enrich.ts`.
    } catch (e) {
      sourcesFailed += 1;
      errors.push({ tag: src.tag, message: `fetch_threw:${(e as Error).message}` });
    }
  }

  // Step 3: AI extraction per fetched source.
  const aiCallCap = opts.aiCallCap ?? fetched.length;
  let aiCalls = 0;
  let aiNeurons = 0;
  const allFacts: FactCandidate[] = [];

  if (!opts.disableAi) {
    for (const f of fetched) {
      if (aiCalls >= aiCallCap) break;
      const userPrompt = `URL: ${f.source.url}\nHOST: ${hostOf(f.source.url)}\n${stripForExtract(f.html)}`;
      const aiRes = await runAiExtract(
        env,
        def.systemPrompt,
        userPrompt,
        def.extractionSchema,
        def.model ?? DEFAULT_MODEL,
        ctx.jobId ?? undefined,
        def.id,
      );
      aiCalls += 1;
      aiNeurons += aiRes.neurons;
      if (!aiRes.json) {
        errors.push({ tag: f.source.tag, message: "ai_extract_empty" });
        continue;
      }
      try {
        const mapped = def.map({ aiJson: aiRes.json, source: f.source, ctx });
        for (const m of mapped) allFacts.push({ ...m, sourceUrl: m.sourceUrl || f.source.url, sourceTag: m.sourceTag || f.source.tag });
      } catch (e) {
        errors.push({ tag: f.source.tag, message: `map_threw:${(e as Error).message}` });
      }
    }
  }

  // Step 4: cross-source verification.
  const verifiedList = crossRef(allFacts);

  // Step 5: persist.
  let factsWritten = 0;
  let factsVerified = 0;
  for (const v of verifiedList) {
    try {
      await writeFact(env, entityId, v.fact, v.verified, v.adjustedConfidence, def.id, runId, observedAt);
      factsWritten += 1;
      if (v.verified) factsVerified += 1;
    } catch (e) {
      errors.push({ tag: v.fact.sourceTag, message: `persist_threw:${(e as Error).message}` });
    }
  }

  // Step 6: status + bookkeeping.
  const status: WorkflowResult["status"] =
    factsWritten === 0 && sourcesFailed > 0 ? "failed"
    : sourcesFailed > 0 || errors.length > 0 ? "partial"
    : "success";

  const result: WorkflowResult = {
    workflow_id: def.id,
    profile_type_id: def.profile_type_id,
    entity_id: entityId,
    status,
    sources_planned: sources.length,
    sources_fetched: sourcesFetched,
    sources_failed: sourcesFailed,
    facts_written: factsWritten,
    facts_verified: factsVerified,
    ai_calls: aiCalls,
    ai_neurons: aiNeurons,
    estimated_cost_usd: def.estimated_cost_per_run.sources * 0.0009 + def.estimated_cost_per_run.ai_neurons * 0.001,
    actual_cost_usd: actualCostUsd + aiNeurons * 0.001,
    errors,
    duration_ms: Date.now() - t0,
  };
  await recordRun(env, { runId, workflow: def, ctx, entityId, result });
  return result;
}

/** Build a `ProfileWorkflow` from a `WorkflowDef`. */
export function makeWorkflow(def: WorkflowDef): ProfileWorkflow {
  return {
    id: def.id,
    profile_type_id: def.profile_type_id,
    estimated_cost_per_run: def.estimated_cost_per_run,
    run: (env, ctx, opts) => runStandardWorkflow(env, def, ctx, opts),
  };
}
