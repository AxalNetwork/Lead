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
  loadAccountFacts, loadBuyerFacts, listMatches, countMatches, deleteMatchesForPersona,
  rowToSpec,
  type PersonaRow,
} from "../personas/repo";
import { scoreEntity, buildEmbeddingText, type PersonaSpec } from "../personas/score";
import { embedPersona, deletePersonaVector, topMatchesForPersona } from "../personas/embed";
import { aiEmbed } from "../ai/extract";
import { rescorePersonaFull, dispatchPersonaRescore } from "../personas/rescore";
import { ensurePersonasSeeded } from "../personas/seed";

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
  const result = scoreEntity(spec, {
    account: kind === "account" ? (facts.facts as never) : null,
    buyer: kind === "buyer" ? (facts.facts as never) : null,
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
  const scored: Array<{ id: string; name: string; fit_score: number; components: import("../personas/score").ScoreComponents; reasons: string[] }> = [];
  for (const id of candidateIds) {
    const facts = spec.kind === "account" ? await loadAccountFacts(c.env, id) : await loadBuyerFacts(c.env, id);
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
