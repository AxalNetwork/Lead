// Task #46: helper called from triggers (signal insert, account/buyer
// edit) to re-score the affected entity against every active persona.
// Single-entity re-score is cheap (no embedding cost — we only re-embed
// the persona on PATCH). For full-persona rescore we dispatch
// WF_RESCORE_PERSONA via the workflow binding.

import type { Env } from "../types";
import {
  listPersonas, rowToSpec, upsertMatch, loadAccountFacts, loadBuyerFacts,
  loadAccountFactsBulk, loadBuyerFactsBulk, bulkWriteBackFit,
  summarizeAccountForExplanation, summarizeBuyerForExplanation,
} from "./repo";
import { scoreEntity } from "./score";
import { explainFit } from "./explain";
import { cosinesForEntities } from "./embed";

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
import { aiEmbed } from "../ai/extract";
import { buildEmbeddingText } from "./score";

// Rescore a single entity (cheap path, fits in the tail of an API
// request via ctx.waitUntil). Iterates active personas of matching
// kind and upserts persona_matches rows.
export async function rescoreEntity(env: Env, entityKind: "account" | "buyer", entityId: string): Promise<{ scored: number }> {
  const personas = await listPersonas(env, { status: "active" });
  const targets = personas.filter((p) => p.kind === entityKind || (entityKind === "account" && p.kind === "account") || (entityKind === "buyer" && p.kind === "buyer"));
  if (!targets.length) return { scored: 0 };

  const facts = entityKind === "account" ? await loadAccountFacts(env, entityId) : await loadBuyerFacts(env, entityId);
  if (!facts) return { scored: 0 };

  // Fetch the entity vector once (when applicable) and re-use it
  // across every persona we score against. Persona vectors are fetched
  // lazily per row from VEC_PERSONAS so a fresh PATCH that re-embedded
  // is reflected immediately. Cosine is computed locally.
  let entityVector: number[] | null = null;
  if (entityKind === "account" && env.VEC_ACCOUNTS) {
    try {
      const rows = await env.VEC_ACCOUNTS.getByIds([entityId]);
      const v = (rows ?? [])[0]?.values;
      if (Array.isArray(v) && v.length) entityVector = v;
    } catch (e) { console.warn("VEC_ACCOUNTS.getByIds (single) failed", (e as Error).message); }
  }
  const personaVecCache = new Map<string, number[] | null>();

  let scored = 0;
  for (const row of targets) {
    const spec = rowToSpec(row);
    let semCos: number | null = null;
    if (entityKind === "account" && entityVector && env.VEC_PERSONAS) {
      let pv = personaVecCache.get(row.id);
      if (pv === undefined) {
        try {
          const rows = await env.VEC_PERSONAS.getByIds([row.id]);
          const v = (rows ?? [])[0]?.values;
          pv = Array.isArray(v) && v.length ? v : null;
        } catch (e) {
          console.warn("VEC_PERSONAS.getByIds failed", (e as Error).message);
          pv = null;
        }
        personaVecCache.set(row.id, pv);
      }
      if (pv) semCos = cosine(entityVector, pv);
    }
    const result = scoreEntity(spec, {
      account: entityKind === "account" ? facts.facts as never : null,
      buyer: entityKind === "buyer" ? facts.facts as never : null,
      semanticCosine: semCos,
    });
    let explanation: string | null = null;
    if (result.fit_score >= 50) {
      explanation = await explainFit(env, {
        persona: { ...spec, name: row.name, thesis: row.thesis, last_modified: row.last_modified },
        entity: {
          kind: entityKind,
          id: entityId,
          name: facts.name,
          last_modified: facts.last_modified ?? "",
          facts: entityKind === "account"
            ? summarizeAccountForExplanation(facts.name, facts.facts as never)
            : summarizeBuyerForExplanation(facts.name, facts.facts as never),
        },
        components: result.components,
        fit_score: result.fit_score,
      });
    }
    await upsertMatch(env, {
      persona_id: row.id,
      entity_kind: entityKind,
      entity_id: entityId,
      fit_score: result.fit_score,
      hard_filter_pass: result.components.hard_filter_pass,
      components: result.components,
      explanation,
      persona_modified_at: row.last_modified,
      entity_modified_at: facts.last_modified,
    });
    scored += 1;
  }

  // Write back max-active-persona fit_score onto the entity row so the
  // dashboard's existing fit_score column reflects the best persona.
  // Bulk path is a degenerate single-id batch — same code path as the
  // full-rescore writeback so account + buyer behavior stay aligned.
  await bulkWriteBackFit(env, entityKind, [entityId]);
  return { scored };
}

// Full-persona rescore. Pages every active entity of the persona's
// kind in batches of `batchSize` and upserts. Used by:
//   - PATCH /api/personas/:id (re-embed + full rescore)
//   - POST /api/personas/:id/rescore-all
//   - RescorePersonaWorkflow (durable, retried)
export async function rescorePersonaFull(
  env: Env,
  personaId: string,
  opts: { batchSize?: number; explainCap?: number } = {},
): Promise<{ scored: number; explained: number }> {
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 200), 500);
  // Hard ceiling on AI explanation calls per workflow run — protects
  // the daily neuron budget. Default 5000 covers every realistic v1
  // dataset; explicitly settable lower for tests / smoke runs.
  const explainCap = Math.max(0, opts.explainCap ?? 5000);

  const row = await env.DB.prepare(`SELECT * FROM personas WHERE id = ? AND deleted_at IS NULL`).bind(personaId).first<import("./repo").PersonaRow>();
  if (!row) return { scored: 0, explained: 0 };
  const spec = rowToSpec(row);

  // Compute the persona vector once; per-batch we'll fetch the entity
  // vectors from VEC_ACCOUNTS via getByIds and compute cosines locally
  // (every entity gets a real semantic_fit, not just the top-K of a
  // single Vectorize.query — that would have left the long tail at the
  // synthetic 50 default).
  let personaVector: number[] | null = null;
  if (spec.kind === "account") {
    personaVector = await aiEmbed(env, buildEmbeddingText({ ...spec, name: row.name, thesis: row.thesis }));
  }

  const tableSql = spec.kind === "account"
    ? `SELECT id FROM accounts WHERE status NOT IN ('lost','disqualified') ORDER BY id LIMIT ? OFFSET ?`
    : `SELECT id FROM buyers ORDER BY id LIMIT ? OFFSET ?`;

  let offset = 0;
  let scored = 0;
  let topRanked: Array<{ id: string; score: number; name: string; facts: unknown; components: import("./score").ScoreComponents; entity_modified_at: string | null }> = [];

  for (;;) {
    const r = await env.DB.prepare(tableSql).bind(batchSize, offset).all<{ id: string }>();
    const ids = (r.results ?? []).map((x) => x.id);
    if (!ids.length) break;
    // Bulk-load facts for the entire page in 4 set-based queries
    // instead of N×4 (one per id) — avoids N+1 against D1.
    const factsMap = spec.kind === "account"
      ? await loadAccountFactsBulk(env, ids)
      : await loadBuyerFactsBulk(env, ids);
    // Per-batch cosine map: covers EVERY id in this page, not just
    // those in a global top-K window.
    const semMap = (spec.kind === "account" && personaVector)
      ? await cosinesForEntities(env, personaVector, { kind: "account", ids })
      : new Map<string, number>();
    for (const id of ids) {
      const facts = factsMap.get(id);
      if (!facts) continue;
      const result = scoreEntity(spec, {
        account: spec.kind === "account" ? (facts.facts as never) : null,
        buyer: spec.kind === "buyer" ? (facts.facts as never) : null,
        semanticCosine: spec.kind === "account" ? (semMap.get(id) ?? null) : null,
      });
      // Defer explanation generation: only the top N by score get an
      // AI explanation, written in a second pass after we know who's
      // on top. This keeps neuron usage bounded for big rescores.
      await upsertMatch(env, {
        persona_id: row.id,
        entity_kind: spec.kind,
        entity_id: id,
        fit_score: result.fit_score,
        hard_filter_pass: result.components.hard_filter_pass,
        components: result.components,
        explanation: null,
        persona_modified_at: row.last_modified,
        entity_modified_at: facts.last_modified,
      });
      scored += 1;
      if (result.fit_score >= 50) {
        topRanked.push({
          id, score: result.fit_score, name: facts.name,
          facts: spec.kind === "account"
            ? summarizeAccountForExplanation(facts.name, facts.facts as never)
            : summarizeBuyerForExplanation(facts.name, facts.facts as never),
          components: result.components,
          entity_modified_at: facts.last_modified,
        });
      }
    }
    // Bulk fit writeback for the whole page (1 aggregate SELECT + 1
    // batched UPDATE instead of N per-row round trips).
    await bulkWriteBackFit(env, spec.kind, ids);
    if (ids.length < batchSize) break;
    offset += batchSize;
  }

  // Generate explanations for EVERY qualifying match (fit_score >= 50),
  // up to explainCap. R2 cache in explainFit is keyed by
  // (persona, entity, persona.last_modified, entity.last_modified) so
  // reruns for unchanged rows are essentially free; the cap is a hard
  // safety net for first-time runs on huge datasets.
  topRanked.sort((a, b) => b.score - a.score);
  let explained = 0;
  for (const t of topRanked.slice(0, explainCap)) {
    const explanation = await explainFit(env, {
      persona: { ...spec, name: row.name, thesis: row.thesis, last_modified: row.last_modified },
      entity: { kind: spec.kind, id: t.id, name: t.name, last_modified: t.entity_modified_at ?? "", facts: t.facts as Record<string, unknown> },
      components: t.components,
      fit_score: t.score,
    });
    if (explanation) {
      const now = new Date().toISOString();
      await env.DB.prepare(`UPDATE persona_matches SET explanation = ?, explanation_at = ? WHERE persona_id = ? AND entity_kind = ? AND entity_id = ?`)
        .bind(explanation, now, row.id, spec.kind, t.id).run();
      explained += 1;
    }
  }

  return { scored, explained };
}

// Best-effort dispatch: prefer the workflow when available, otherwise
// run inline (still fully durable inside the request lifetime via
// ctx.waitUntil at the call site).
export async function dispatchPersonaRescore(env: Env, personaId: string): Promise<{ workflowId?: string; ran?: boolean }> {
  if (env.WF_RESCORE_PERSONA) {
    try {
      const wf = await env.WF_RESCORE_PERSONA.create({ params: { personaId } });
      return { workflowId: wf.id };
    } catch (e) {
      console.warn("WF_RESCORE_PERSONA.create failed; falling back inline", (e as Error).message);
    }
  }
  await rescorePersonaFull(env, personaId);
  return { ran: true };
}
