// Task #46: Persona profiler REST API.
//
// Mounted at /api/personas. Endpoints:
//   GET    /                       list active personas (+ fit_count, top-5)
//   POST   /                       create persona (re-embed + full rescore async)
//   GET    /:id                    detail
//   PATCH  /:id                    edit (re-embed + full rescore async)
//   DELETE /:id                    soft-delete
//   POST   /:id/clone              duplicate
//   POST   /:id/rescore-all        full rescore (dispatched via workflow)
//   POST   /:id/score-entity       ad-hoc one-entity score (no persistence)
//   GET    /:id/matches            paged matches
//   POST   /preview                debounced live-preview (top-25, no persistence)
//   POST   /:id/analyze            LLM analysis over persona + top-50; persists notes

import { Hono } from "hono";
import type { Env } from "../types";
import {
  listPersonas, getPersona, insertPersona, updatePersona, softDeletePersona,
  setPersonaEmbeddingMeta, setPersonaNotes,
  loadAccountFacts, loadBuyerFacts, loadAccountFactsBulk, loadBuyerFactsBulk,
  listMatches, countMatches, deleteMatchesForPersona,
  rowToSpec,
  type PersonaRow,
} from "../personas/repo";
import { scoreEntity, buildEmbeddingText, type PersonaSpec } from "../personas/score";
import { embedPersona, deletePersonaVector, topMatchesForPersona } from "../personas/embed";
import { aiEmbed } from "../ai/extract";
import { rescorePersonaFull, dispatchPersonaRescore } from "../personas/rescore";
import { ensurePersonasSeeded } from "../personas/seed";
// Task #8: real persona matching against the unified u_entities graph.
import {
  scoreEntity as scoreEntityForPersonaMatching,
  scoreBatch as scoreBatchPersonaMatching,
  listCandidates as listPersonaEntityCandidates,
  upsertMatch as upsertPersonaEntityMatch,
  loadPersonEntity, scoreEntityForPersona,
} from "../services/personaMatching";

// Task #8: dispatch the entity matcher after a persona is created /
// cloned / edited. Workflow dispatch is the happy path; on failure
// (or when the binding is missing) we fall back to a bounded inline
// scoring pass so a newly-created persona always has *some* candidate
// rows on its first read, even if the workflow plane is unreachable.
// The nightly cron converges any auto rows older than 30 days.
// Inline scoring fallback is gated behind PERSONA_MATCH_INLINE_FALLBACK
// (default "1" everywhere except ENVIRONMENT=production, where it
// defaults off). This aligns the hot path with the
// no-scoring-in-request-handlers policy while still letting dev/staging
// get same-tick candidates without a workflow plane. Operators flip
// the flag to "1" in prod to opt into the bounded inline pass.
function inlineFallbackEnabled(env: Env): boolean {
  const flag = (env as { PERSONA_MATCH_INLINE_FALLBACK?: string }).PERSONA_MATCH_INLINE_FALLBACK;
  const envName = (env as { ENVIRONMENT?: string }).ENVIRONMENT ?? "dev";
  if (flag === "1") return true;
  if (flag === "0") return false;
  return envName !== "production";
}

async function dispatchPersonaEntityMatch(env: Env, personaId: string): Promise<void> {
  const { recordMatchJob } = await import("../services/personaMatching");
  if (env.WF_PERSONA_ENTITY_MATCH) {
    try {
      // No maxEntities cap — the workflow runs to completion across
      // every active person entity (chunked pagination internally).
      const wf = await env.WF_PERSONA_ENTITY_MATCH.create({ params: { personaId, batchSize: 100 } });
      await recordMatchJob(env, "dispatch", "ok", { personaId, workflow_id: wf.id });
      return;
    } catch (e) {
      // SLO_VIOLATION: workflow dispatch failed — the fallback below
      // only re-scores up to 200 entities, so any larger graph is
      // left partial until the nightly refresh converges it.
      console.error("SLO_VIOLATION persona_match_dispatch_wf_failed", personaId, (e as Error).message);
      await recordMatchJob(env, "dispatch", "failed", { personaId, error: (e as Error).message, fallback: "inline", slo_violation: true });
    }
  }
  // Bounded inline fallback so a request handler never melts the worker;
  // the dispatch-failed job row above flags the SLO miss for ops.
  // Skipped in production unless PERSONA_MATCH_INLINE_FALLBACK=1 to
  // honor the "no scoring in request hot path" architectural rule.
  if (!inlineFallbackEnabled(env)) {
    await recordMatchJob(env, "dispatch", "halted", { personaId, fallback: "inline", reason: "inline_disabled_in_production", slo_violation: true });
    return;
  }
  try {
    const r = await scoreBatchPersonaMatching(env, personaId, { batchSize: 50, maxEntities: 200 });
    const partial = r.scored + r.errors >= 200; // hit the cap
    if (partial) {
      console.error("SLO_VIOLATION persona_match_inline_fallback_partial", personaId, JSON.stringify(r));
    }
    await recordMatchJob(env, "dispatch", r.halted ? "halted" : "ok", { personaId, fallback: "inline", slo_violation: partial || r.halted, ...r });
  } catch (e) {
    console.error("SLO_VIOLATION persona_match_inline_fallback_failed", personaId, (e as Error).message);
    await recordMatchJob(env, "dispatch", "failed", { personaId, fallback: "inline", error: (e as Error).message, slo_violation: true });
  }
}

export const personasRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const PATCHABLE_KEYS = new Set([
  "name","kind","status","thesis","hard_filters_json",
  "size_min","size_max","size_bands_json","geos_json","industries_json",
  "techs_required_json","techs_preferred_json","techs_excluded_json",
  "signal_kinds_json","buyer_titles_json","buyer_seniority_json","buyer_departments_json",
  "weights_json","semantic_fit_threshold","recency_boost",
]);

function normalizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!PATCHABLE_KEYS.has(k)) continue;
    if (k.endsWith("_json") && (Array.isArray(v) || (v && typeof v === "object"))) out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

function previewSpecFromBody(body: Record<string, unknown>): PersonaSpec & { name: string; thesis: string | null } {
  const arr = (k: string): string[] => {
    const v = body[k];
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
    if (typeof v === "string" && v) { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } }
    return [];
  };
  const obj = (k: string): Record<string, unknown> => {
    const v = body[k];
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    if (typeof v === "string" && v) { try { const j = JSON.parse(v); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; } }
    return {};
  };
  const num = (k: string): number | null => (typeof body[k] === "number" ? (body[k] as number) : (typeof body[k] === "string" && body[k] ? Number(body[k]) : null));
  return {
    id: "preview",
    kind: (body.kind === "buyer" ? "buyer" : "account"),
    name: typeof body.name === "string" ? body.name : "Preview",
    thesis: typeof body.thesis === "string" ? body.thesis : null,
    size_min: num("size_min"),
    size_max: num("size_max"),
    size_bands: arr("size_bands_json").length ? arr("size_bands_json") : arr("size_bands"),
    geos: arr("geos_json").length ? arr("geos_json") : arr("geos"),
    industries: arr("industries_json").length ? arr("industries_json") : arr("industries"),
    techs_required: arr("techs_required_json").length ? arr("techs_required_json") : arr("techs_required"),
    techs_preferred: arr("techs_preferred_json").length ? arr("techs_preferred_json") : arr("techs_preferred"),
    techs_excluded: arr("techs_excluded_json").length ? arr("techs_excluded_json") : arr("techs_excluded"),
    signal_kinds: arr("signal_kinds_json").length ? arr("signal_kinds_json") : arr("signal_kinds"),
    buyer_titles: arr("buyer_titles_json").length ? arr("buyer_titles_json") : arr("buyer_titles"),
    buyer_seniority: arr("buyer_seniority_json").length ? arr("buyer_seniority_json") : arr("buyer_seniority"),
    buyer_departments: arr("buyer_departments_json").length ? arr("buyer_departments_json") : arr("buyer_departments"),
    hard_filters: Object.keys(obj("hard_filters_json")).length ? obj("hard_filters_json") : obj("hard_filters"),
    weights: (Object.keys(obj("weights_json")).length ? obj("weights_json") : obj("weights")) as PersonaSpec["weights"],
    semantic_fit_threshold: typeof body.semantic_fit_threshold === "number" ? (body.semantic_fit_threshold as number) : 0.55,
    recency_boost: typeof body.recency_boost === "number" ? (body.recency_boost as number) : 0,
  };
}

// ----- list (also seeds on first call)
personasRoute.get("/", async (c) => {
  await ensurePersonasSeeded(c.env);
  const status = c.req.query("status") ?? "active";
  const items = await listPersonas(c.env, { status });
  // Augment with fit_count + top-5
  const out = [];
  for (const p of items) {
    const fitCount = await countMatches(c.env, p.id, 60);
    const top5 = await listMatches(c.env, p.id, { kind: p.kind, minScore: 0, limit: 5 });
    out.push({ ...p, fit_count: fitCount, top5 });
  }
  return c.json({ items: out });
});

personasRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) return c.json({ error: "bad_request", message: "name required" }, 400);
  const fields = normalizeBody(body);
  fields.name = body.name;
  if (body.kind === "account" || body.kind === "buyer") fields.kind = body.kind;
  const row = await insertPersona(c.env, fields as Partial<PersonaRow> & { name: string }, c.get("email"));
  // Embed + full rescore in the background.
  c.executionCtx.waitUntil((async () => {
    try {
      const spec = rowToSpec(row);
      const { vector, text } = await embedPersona(c.env, { ...spec, name: row.name, thesis: row.thesis });
      if (vector) await setPersonaEmbeddingMeta(c.env, row.id, vector.length, text);
      await dispatchPersonaRescore(c.env, row.id);
      await dispatchPersonaEntityMatch(c.env, row.id);
    } catch (e) { console.warn("post-create persona setup failed", (e as Error).message); }
  })());
  return c.json(row, 201);
});

personasRoute.get("/:id", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const fitCount = await countMatches(c.env, row.id, 60);
  return c.json({ ...row, fit_count: fitCount });
});

personasRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  const fields = normalizeBody(body);
  if (typeof body.name === "string") fields.name = body.name;
  const row = await updatePersona(c.env, id, fields as Partial<PersonaRow>, c.get("email"));
  if (!row) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil((async () => {
    try {
      const spec = rowToSpec(row);
      const { vector, text } = await embedPersona(c.env, { ...spec, name: row.name, thesis: row.thesis });
      if (vector) await setPersonaEmbeddingMeta(c.env, row.id, vector.length, text);
      await dispatchPersonaRescore(c.env, row.id);
      await dispatchPersonaEntityMatch(c.env, row.id);
    } catch (e) { console.warn("post-patch persona setup failed", (e as Error).message); }
  })());
  return c.json(row);
});

personasRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await softDeletePersona(c.env, id, c.get("email"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil((async () => {
    try { await deletePersonaVector(c.env, id); await deleteMatchesForPersona(c.env, id); } catch (e) { console.warn("post-delete cleanup failed", (e as Error).message); }
  })());
  return c.json({ ok: true });
});

personasRoute.post("/:id/clone", async (c) => {
  const src = await getPersona(c.env, c.req.param("id"));
  if (!src) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const clone = await insertPersona(c.env, {
    ...src,
    id: undefined as unknown as string,
    name: body.name ?? `${src.name} (copy)`,
    status: "active",
    embedding_dim: null,
    embedded_at: null,
    embedding_text: null,
    persona_notes: null,
    notes_generated_at: null,
  } as Partial<PersonaRow> & { name: string }, c.get("email"));
  c.executionCtx.waitUntil((async () => {
    try {
      const spec = rowToSpec(clone);
      const { vector, text } = await embedPersona(c.env, { ...spec, name: clone.name, thesis: clone.thesis });
      if (vector) await setPersonaEmbeddingMeta(c.env, clone.id, vector.length, text);
      await dispatchPersonaRescore(c.env, clone.id);
      await dispatchPersonaEntityMatch(c.env, clone.id);
    } catch (e) { console.warn("clone setup failed", (e as Error).message); }
  })());
  return c.json(clone, 201);
});

personasRoute.post("/:id/rescore-all", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const r = await dispatchPersonaRescore(c.env, row.id);
  return c.json({ ok: true, ...r });
});

personasRoute.post("/:id/score-entity", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { entity_kind?: string; entity_id?: string } | null;
  if (!body?.entity_kind || !body?.entity_id) return c.json({ error: "bad_request", message: "entity_kind + entity_id required" }, 400);
  const kind = body.entity_kind === "buyer" ? "buyer" : "account";
  const facts = kind === "account" ? await loadAccountFacts(c.env, body.entity_id) : await loadBuyerFacts(c.env, body.entity_id);
  if (!facts) return c.json({ error: "entity_not_found" }, 404);
  const spec = rowToSpec(row);
  // Compute semantic cosine for parity with rescore: pull the persona
  // and entity vectors from Vectorize and dot-product them locally.
  let semCos: number | null = null;
  if (kind === "account" && c.env.VEC_ACCOUNTS && c.env.VEC_PERSONAS) {
    try {
      const [pv, ev] = await Promise.all([
        c.env.VEC_PERSONAS.getByIds([row.id]),
        c.env.VEC_ACCOUNTS.getByIds([body.entity_id]),
      ]);
      const a = (pv ?? [])[0]?.values;
      const b = (ev ?? [])[0]?.values;
      if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.length) {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        if (na && nb) semCos = dot / (Math.sqrt(na) * Math.sqrt(nb));
      }
    } catch (e) { console.warn("score-entity cosine fetch failed", (e as Error).message); }
  }
  const result = scoreEntity(spec, {
    account: kind === "account" ? (facts.facts as never) : null,
    buyer: kind === "buyer" ? (facts.facts as never) : null,
    semanticCosine: semCos,
  });
  return c.json({ persona_id: row.id, entity_kind: kind, entity_id: body.entity_id, ...result });
});

personasRoute.get("/:id/matches", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 50));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const minScore = Math.max(0, Number(c.req.query("min_score")) || 0);
  const items = await listMatches(c.env, row.id, { kind: row.kind, limit, offset, minScore });
  const total = await countMatches(c.env, row.id, minScore);
  return c.json({ items, total, nextOffset: items.length === limit ? offset + limit : null });
});

// -------------------------------------------------------------------------
// Task #8: real persona matching against unified u_entities (person
// graph). Separate read endpoint from /matches (which scores accounts/
// buyers from Task #46) — these two coexist by design.
// -------------------------------------------------------------------------

// POST /:id/run-matching → dispatches the entity-matching workflow.
// Body: { batch_size?, max_entities?, force? } (all optional).
// Returns { ok, workflow_id?, scored?, errors? } — inline fallback when
// WF_PERSONA_ENTITY_MATCH is not bound.
personasRoute.post("/:id/run-matching", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { batch_size?: number; max_entities?: number | null } | null;
  const batchSize = Math.min(Math.max(1, Number(body?.batch_size) || 100), 500);
  // max_entities is optional — default null = "every active person
  // entity". Operators pass a number to bound a manual run.
  const maxEntities = body?.max_entities == null ? null
    : Math.min(Math.max(1, Number(body.max_entities)), 1_000_000);
  const { recordMatchJob } = await import("../services/personaMatching");
  if (c.env.WF_PERSONA_ENTITY_MATCH) {
    try {
      const wf = await c.env.WF_PERSONA_ENTITY_MATCH.create({ params: { personaId: row.id, batchSize, maxEntities } });
      return c.json({ ok: true, dispatched: "workflow", job_id: wf.id, workflow_id: wf.id, persona_id: row.id });
    } catch (e) {
      console.error("SLO_VIOLATION run_matching_wf_dispatch_failed", row.id, (e as Error).message);
      await recordMatchJob(c.env, "dispatch", "failed", { personaId: row.id, route: "run-matching", error: (e as Error).message, slo_violation: true });
    }
  }
  // Inline fallback gated by PERSONA_MATCH_INLINE_FALLBACK (default OFF
  // in production) — same hot-path policy as dispatchPersonaEntityMatch.
  if (!inlineFallbackEnabled(c.env)) {
    await recordMatchJob(c.env, "dispatch", "halted", { personaId: row.id, route: "run-matching", reason: "inline_disabled_in_production", slo_violation: true });
    return c.json({ ok: false, dispatched: "none", persona_id: row.id, reason: "inline_disabled_in_production", retry: "workflow_plane_required" }, 503);
  }
  const jobId = `inline-${row.id}-${Date.now()}`;
  const r = await scoreBatchPersonaMatching(c.env, row.id, { batchSize, maxEntities: Math.min(maxEntities ?? 500, 500) });
  await recordMatchJob(c.env, "dispatch", r.halted ? "halted" : "ok", { personaId: row.id, route: "run-matching", fallback: "inline", slo_violation: r.halted, ...r });
  return c.json({ ok: true, dispatched: "inline", job_id: jobId, persona_id: row.id, ...r });
});

// GET /:id/candidates?min_score=0.7&limit=50&offset=0
personasRoute.get("/:id/candidates", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const minScore = Math.max(0, Math.min(1, Number(c.req.query("min_score")) || 0));
  const limit = Math.min(Math.max(1, Number(c.req.query("limit")) || 50), 500);
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const items = await listPersonaEntityCandidates(c.env, row.id, { minScore, limit, offset });
  return c.json({ persona_id: row.id, items, nextOffset: items.length === limit ? offset + limit : null });
});

// POST /:id/candidates → manual upsert. Body: { entity_id, score? }.
// score omitted ⇒ compute via the matcher and persist as 'manual'.
personasRoute.post("/:id/candidates", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { entity_id?: string; score?: number } | null;
  if (!body?.entity_id) return c.json({ error: "bad_request", message: "entity_id required" }, 400);
  const entity = await loadPersonEntity(c.env, body.entity_id);
  if (!entity) return c.json({ error: "entity_not_found" }, 404);
  const result = await scoreEntityForPersona(c.env, row, entity);
  if (typeof body.score === "number" && Number.isFinite(body.score)) {
    result.score = Math.max(0, Math.min(1, body.score));
  }
  await upsertPersonaEntityMatch(c.env, row.id, body.entity_id, result, { source: "manual" });
  return c.json({ ok: true, persona_id: row.id, entity_id: body.entity_id, score: result.score, source: "manual" });
});

// POST /:id/score-entity-graph → single-entity sync score (for debugging).
personasRoute.post("/:id/score-entity-graph", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { entity_id?: string } | null;
  if (!body?.entity_id) return c.json({ error: "bad_request", message: "entity_id required" }, 400);
  const result = await scoreEntityForPersonaMatching(c.env, row.id, body.entity_id);
  if (!result) return c.json({ error: "entity_not_found_or_not_person" }, 404);
  return c.json({ persona_id: row.id, entity_id: body.entity_id, ...result });
});

// Debounced live-preview. Does NOT persist anything. Embeds the
// preview persona, queries VEC_ACCOUNTS for top-K, then scores those K
// candidates inline. Returns top 25.
personasRoute.post("/preview", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  const spec = previewSpecFromBody(body);
  const text = buildEmbeddingText(spec);
  let semMap = new Map<string, number>();
  let candidateIds: string[] = [];
  if (spec.kind === "account" && c.env.VEC_ACCOUNTS) {
    const vec = await aiEmbed(c.env, text);
    if (vec) {
      semMap = await topMatchesForPersona(c.env, vec, { kind: "account", topK: 200 });
      candidateIds = Array.from(semMap.keys());
    }
  }
  // Fallback when there's no Vectorize index populated yet: take the
  // most-recently-updated 200 entities so the preview still shows
  // something rather than an empty pane.
  if (!candidateIds.length) {
    const r = spec.kind === "account"
      ? await c.env.DB.prepare(`SELECT id FROM accounts WHERE status NOT IN ('lost','disqualified') ORDER BY updated_at DESC LIMIT 200`).all<{ id: string }>()
      : await c.env.DB.prepare(`SELECT id FROM buyers ORDER BY updated_at DESC LIMIT 200`).all<{ id: string }>();
    candidateIds = (r.results ?? []).map((x) => x.id);
  }
  // Bulk-load facts for all candidates in one set of set-based queries
  // to keep the preview snappy (<3s SLA) on realistic data volumes.
  const factsMap = spec.kind === "account"
    ? await loadAccountFactsBulk(c.env, candidateIds)
    : await loadBuyerFactsBulk(c.env, candidateIds);
  const scored: Array<{ id: string; name: string; fit_score: number; components: import("../personas/score").ScoreComponents; reasons: string[] }> = [];
  for (const id of candidateIds) {
    const facts = factsMap.get(id);
    if (!facts) continue;
    const result = scoreEntity(spec, {
      account: spec.kind === "account" ? (facts.facts as never) : null,
      buyer: spec.kind === "buyer" ? (facts.facts as never) : null,
      semanticCosine: semMap.get(id) ?? null,
    });
    scored.push({ id, name: facts.name, fit_score: result.fit_score, components: result.components, reasons: result.components.reasons });
  }
  scored.sort((a, b) => b.fit_score - a.fit_score);
  return c.json({ items: scored.slice(0, 25), candidate_count: candidateIds.length });
});

// LLM analysis over persona + top-50 matches. Persists the result.
personasRoute.post("/:id/analyze", async (c) => {
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!c.env.AI) return c.json({ error: "ai_unavailable" }, 503);
  const top = await listMatches(c.env, row.id, { kind: row.kind, limit: 50, minScore: 0 });
  const compact = top.map((t) => ({
    name: t.entity_name, score: t.fit_score, domain: t.entity_domain,
    industry: t.entity_industry, employees: t.entity_employees,
  }));
  const model = c.env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  let notes = "";
  try {
    const res = (await c.env.AI.run(model, {
      messages: [
        { role: "system", content: "You are a sales-strategy analyst. Given a target persona and its top 50 matches, produce 5 short bullet observations: dominant industries, geo skew, common signals, suggested outreach angle, gaps in coverage. Plain text, no markdown." },
        { role: "user", content: `Persona: ${row.name}\nThesis: ${row.thesis ?? "—"}\nTop matches: ${JSON.stringify(compact).slice(0, 4000)}` },
      ],
    })) as { response?: string };
    notes = (res?.response ?? "").trim().slice(0, 4000);
  } catch (e) {
    return c.json({ error: "ai_failed", message: (e as Error).message }, 502);
  }
  if (!notes) return c.json({ error: "no_analysis_returned" }, 502);
  await setPersonaNotes(c.env, row.id, notes);
  return c.json({ ok: true, notes });
});

// Internal endpoint used by RescorePersonaWorkflow tests. Synchronous
// full-rescore is expensive (page every entity, embed, score); gate it
// behind a header so it can't be invoked accidentally from the
// dashboard or by an authenticated user. Production callers should use
// POST /:id/rescore-all (workflow-dispatched) instead.
personasRoute.post("/:id/_rescore-now", async (c) => {
  // Fail closed: when PERSONA_RESCORE_SECRET is unset (dev or
  // misconfigured prod) the endpoint refuses every request rather than
  // silently allowing access. Constant-time compare avoids timing
  // oracles on the secret.
  const expected = c.env.PERSONA_RESCORE_SECRET;
  const supplied = c.req.header("x-rescore-secret") ?? "";
  if (!expected || typeof expected !== "string" || expected.length < 16) {
    return c.json({ error: "forbidden:secret_unset" }, 403);
  }
  if (!constantTimeEquals(supplied, expected)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const row = await getPersona(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const r = await rescorePersonaFull(c.env, row.id);
  return c.json({ ok: true, ...r });
});
