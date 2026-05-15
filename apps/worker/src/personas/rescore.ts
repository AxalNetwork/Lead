// Task #46: helper called from triggers (signal insert, account/buyer
// edit) to re-score the affected entity against every active persona.
// Single-entity re-score is cheap (no embedding cost — we only re-embed
// the persona on PATCH). For full-persona rescore we dispatch
// WF_RESCORE_PERSONA via the workflow binding.

import type { Env } from "../types";
import {
  listPersonas, rowToSpec, upsertMatch, loadAccountFacts, loadBuyerFacts,
  summarizeAccountForExplanation, summarizeBuyerForExplanation,
} from "./repo";
import { scoreEntity } from "./score";
import { explainFit } from "./explain";
import { topMatchesForPersona } from "./embed";
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

  let scored = 0;
  for (const row of targets) {
    const spec = rowToSpec(row);
    let semCos: number | null = null;
    if (entityKind === "account" && env.VEC_PERSONAS && env.VEC_ACCOUNTS) {
      // Single-entity rescore: query personas index by the entity id
      // would require us to know the entity vector. Cheaper: skip
      // semantic_fit override (scorer falls back to 50). Full-persona
      // workflow is the path that pre-computes the cosine map.
      semCos = null;
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
  await writeBackEntityFit(env, entityKind, entityId);
  return { scored };
}

async function writeBackEntityFit(env: Env, entityKind: "account" | "buyer", entityId: string): Promise<void> {
  const r = await env.DB.prepare(
    `SELECT MAX(pm.fit_score) AS m
       FROM persona_matches pm
       JOIN personas p ON p.id = pm.persona_id
      WHERE pm.entity_kind = ? AND pm.entity_id = ?
        AND p.status = 'active' AND p.deleted_at IS NULL`,
  ).bind(entityKind, entityId).first<{ m: number | null }>();
  const max = r?.m ?? 0;
  if (entityKind === "account") {
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE accounts SET fit_score = ?, account_score = ROUND((0.6 * intent_score) + (0.4 * ?), 2), updated_at = ? WHERE id = ?`)
      .bind(max, max, now, entityId).run();
  }
  // buyers table doesn't have a fit_score column; the matches table
  // is the source of truth.
}

// Full-persona rescore. Pages every active entity of the persona's
// kind in batches of `batchSize` and upserts. Used by:
//   - PATCH /api/personas/:id (re-embed + full rescore)
//   - POST /api/personas/:id/rescore-all
//   - RescorePersonaWorkflow (durable, retried)
export async function rescorePersonaFull(
  env: Env,
  personaId: string,
  opts: { batchSize?: number; explainTopN?: number } = {},
): Promise<{ scored: number }> {
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 200), 500);
  const explainTopN = opts.explainTopN ?? 50;

  const row = await env.DB.prepare(`SELECT * FROM personas WHERE id = ? AND deleted_at IS NULL`).bind(personaId).first<import("./repo").PersonaRow>();
  if (!row) return { scored: 0 };
  const spec = rowToSpec(row);

  // Pre-compute semantic cosines for accounts via Vectorize topK query
  // (one query covers up to 1k accounts — enough for v1).
  let semMap = new Map<string, number>();
  if (spec.kind === "account") {
    const vec = await aiEmbed(env, buildEmbeddingText({ ...spec, name: row.name, thesis: row.thesis }));
    if (vec) semMap = await topMatchesForPersona(env, vec, { kind: "account", topK: 1000 });
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
    for (const id of ids) {
      const facts = spec.kind === "account" ? await loadAccountFacts(env, id) : await loadBuyerFacts(env, id);
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
      if (spec.kind === "account") await writeBackEntityFit(env, "account", id);
    }
    if (ids.length < batchSize) break;
    offset += batchSize;
  }

  // Generate explanations for top-N highest-scoring matches.
  topRanked.sort((a, b) => b.score - a.score);
  for (const t of topRanked.slice(0, explainTopN)) {
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
    }
  }

  return { scored };
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
