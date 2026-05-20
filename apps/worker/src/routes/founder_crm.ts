// Task #5: Investor Reputation + Founder CRM — API surface.
//
//   POST  /api/founder-feedback                        anonymous review intake
//   POST  /api/founder-pipelines                       create owner-scoped pipeline
//   GET   /api/founder-pipelines                       list owner's pipelines
//   GET   /api/founder-pipelines/:id                   detail + investor cards
//   PATCH /api/founder-pipelines/:id                   update purpose/status/etc
//   POST  /api/founder-pipelines/:id/investors         add investor card
//   PATCH /api/founder-pipelines/:id/investors/:invId  update stage/notes (journals
//                                                      a founder_pipeline_events row
//                                                      on legal stage transitions)
//   GET   /api/founder-pipelines/:id/suggestions       suggested investors via intros
//   GET   /api/investors/:id/reputation                public projection
//
// All routes sit behind accessGuard at the /api/* layer (see index.ts).
// Pipelines are private to c.var.email; admins (c.var.is_admin) bypass
// the owner filter and see raw (un-redacted) reputation rows.

import { Hono } from "hono";
import type { Env } from "../types";
import { anonymizeFeedback } from "../services/founderCrm/anonymize";
import { isStage, isLegalTransition, defaultStage, type Stage } from "../services/founderCrm/stages";
import { projectPublicReputation, type RawReputationRow } from "../services/founderCrm/projection";
import { buildSuggestions } from "../services/founderCrm/suggestions";
import { recomputeInvestorReputation } from "../services/founderCrm/reputation";

type Vars = { email: string; is_admin: boolean };

export const founderCrmRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── Anonymous founder feedback ──────────────────────────────────────

founderCrmRoute.post("/founder-feedback", async (c) => {
  const salt = (c.env as Env & { FOUNDER_FEEDBACK_SALT?: string }).FOUNDER_FEEDBACK_SALT;
  if (!salt || typeof salt !== "string" || salt.length < 16) {
    // Honest degradation per Task #14: refuse rather than fake.
    return c.json({ error: "feedback_unavailable", reason: "salt_unconfigured" }, 503);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const anon = await anonymizeFeedback(body, salt);
  if (!anon) return c.json({ error: "invalid_body" }, 400);

  const id = `ff_${crypto.randomUUID()}`;
  try {
    await c.env.DB.prepare(
      `INSERT INTO founder_feedback (
         id, investor_entity_id, raise_year, raise_outcome, terms_summary,
         behavior_rating, speed_to_no_days, free_text, submitter_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submitter_hash) DO UPDATE SET
         raise_outcome   = excluded.raise_outcome,
         terms_summary   = excluded.terms_summary,
         behavior_rating = excluded.behavior_rating,
         speed_to_no_days= excluded.speed_to_no_days,
         free_text       = excluded.free_text,
         created_at      = CURRENT_TIMESTAMP`,
    ).bind(
      id, anon.investor_entity_id, anon.raise_year, anon.raise_outcome,
      anon.terms_summary, anon.behavior_rating, anon.speed_to_no_days,
      anon.free_text, anon.submitter_hash,
    ).run();
  } catch (e) {
    return c.json({ error: "persist_failed", message: (e as Error).message }, 500);
  }

  // Recompute the affected investor's reputation row in the background so
  // the public projection picks up the new sample without waiting for the
  // nightly sweep. Bounded to a single investor; safe to waitUntil.
  c.executionCtx.waitUntil(
    recomputeInvestorReputation(c.env, anon.investor_entity_id)
      .then(() => undefined)
      .catch((e) => console.warn("recompute after feedback failed", (e as Error).message)),
  );

  return c.json({ ok: true }, 202);
});

// ── Pipelines: create / list / detail / update ──────────────────────

founderCrmRoute.post("/founder-pipelines", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    raise_purpose?: string;
    target_round?: string;
    target_amount_usd?: number;
    founder_entity_id?: string;
  };
  if (!body.raise_purpose || typeof body.raise_purpose !== "string") {
    return c.json({ error: "raise_purpose_required" }, 400);
  }
  const id = `fpipe_${crypto.randomUUID()}`;
  await c.env.DB.prepare(
    `INSERT INTO founder_pipelines (id, owner_email, founder_entity_id, raise_purpose, target_round, target_amount_usd)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, c.var.email,
    body.founder_entity_id ?? null,
    body.raise_purpose.slice(0, 500),
    body.target_round ?? null,
    typeof body.target_amount_usd === "number" ? body.target_amount_usd : null,
  ).run();
  return c.json({ id, owner_email: c.var.email, raise_purpose: body.raise_purpose, status: "open" });
});

founderCrmRoute.get("/founder-pipelines", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id, owner_email, founder_entity_id, raise_purpose, target_round,
            target_amount_usd, status, created_at, updated_at
       FROM founder_pipelines
      WHERE owner_email = ?
      ORDER BY updated_at DESC LIMIT 200`,
  ).bind(c.var.email).all<Record<string, unknown>>();
  return c.json({ items: r.results ?? [] });
});

async function loadOwnedPipeline(env: Env, id: string, email: string, isAdmin: boolean) {
  const row = await env.DB.prepare(
    `SELECT id, owner_email, founder_entity_id, raise_purpose, target_round,
            target_amount_usd, status, created_at, updated_at
       FROM founder_pipelines WHERE id = ?`,
  ).bind(id).first<{ id: string; owner_email: string } & Record<string, unknown>>();
  if (!row) return { row: null, forbidden: false };
  if (!isAdmin && row.owner_email !== email) return { row: null, forbidden: true };
  return { row, forbidden: false };
}

founderCrmRoute.get("/founder-pipelines/:id", async (c) => {
  const { row, forbidden } = await loadOwnedPipeline(c.env, c.req.param("id"), c.var.email, c.var.is_admin);
  if (forbidden) return c.json({ error: "forbidden" }, 403);
  if (!row) return c.json({ error: "not_found" }, 404);
  const inv = await c.env.DB.prepare(
    `SELECT id, investor_entity_id, stage, last_touch_at, next_step, notes, created_at, updated_at
       FROM founder_pipeline_investors
      WHERE pipeline_id = ?
      ORDER BY updated_at DESC`,
  ).bind(row.id).all<Record<string, unknown>>();
  return c.json({ pipeline: row, investors: inv.results ?? [] });
});

founderCrmRoute.patch("/founder-pipelines/:id", async (c) => {
  const { row, forbidden } = await loadOwnedPipeline(c.env, c.req.param("id"), c.var.email, c.var.is_admin);
  if (forbidden) return c.json({ error: "forbidden" }, 403);
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    raise_purpose?: string; target_round?: string;
    target_amount_usd?: number; status?: string;
  };
  const status = body.status && ["open", "closed", "abandoned"].includes(body.status) ? body.status : undefined;
  await c.env.DB.prepare(
    `UPDATE founder_pipelines SET
       raise_purpose     = COALESCE(?, raise_purpose),
       target_round      = COALESCE(?, target_round),
       target_amount_usd = COALESCE(?, target_amount_usd),
       status            = COALESCE(?, status),
       updated_at        = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(
    body.raise_purpose ?? null,
    body.target_round ?? null,
    typeof body.target_amount_usd === "number" ? body.target_amount_usd : null,
    status ?? null,
    row.id,
  ).run();
  return c.json({ ok: true });
});

// ── Investor cards on a pipeline ────────────────────────────────────

founderCrmRoute.post("/founder-pipelines/:id/investors", async (c) => {
  const { row, forbidden } = await loadOwnedPipeline(c.env, c.req.param("id"), c.var.email, c.var.is_admin);
  if (forbidden) return c.json({ error: "forbidden" }, 403);
  if (!row) return c.json({ error: "pipeline_not_found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    investor_entity_id?: string; stage?: string; next_step?: string; notes?: string;
  };
  if (!body.investor_entity_id || typeof body.investor_entity_id !== "string") {
    return c.json({ error: "investor_entity_id_required" }, 400);
  }
  const stage: Stage = body.stage && isStage(body.stage) ? body.stage : defaultStage();
  const id = `fpi_${crypto.randomUUID()}`;
  try {
    await c.env.DB.prepare(
      `INSERT INTO founder_pipeline_investors (id, pipeline_id, investor_entity_id, stage, next_step, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, row.id, body.investor_entity_id, stage, body.next_step ?? null, body.notes ?? null).run();
  } catch (e) {
    // UNIQUE(pipeline_id, investor_entity_id) — already on board.
    return c.json({ error: "already_on_pipeline", message: (e as Error).message }, 409);
  }
  await c.env.DB.prepare(
    `INSERT INTO founder_pipeline_events (id, pipeline_id, pipeline_investor_id, from_stage, to_stage)
     VALUES (?, ?, ?, NULL, ?)`,
  ).bind(`fpe_${crypto.randomUUID()}`, row.id, id, stage).run();
  return c.json({ id, pipeline_id: row.id, investor_entity_id: body.investor_entity_id, stage });
});

founderCrmRoute.patch("/founder-pipelines/:id/investors/:invId", async (c) => {
  const { row, forbidden } = await loadOwnedPipeline(c.env, c.req.param("id"), c.var.email, c.var.is_admin);
  if (forbidden) return c.json({ error: "forbidden" }, 403);
  if (!row) return c.json({ error: "pipeline_not_found" }, 404);
  const cur = await c.env.DB.prepare(
    `SELECT id, stage FROM founder_pipeline_investors WHERE id = ? AND pipeline_id = ?`,
  ).bind(c.req.param("invId"), row.id).first<{ id: string; stage: string }>();
  if (!cur) return c.json({ error: "card_not_found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    stage?: string; next_step?: string; notes?: string; last_touch_at?: string;
  };
  let nextStage: Stage | null = null;
  if (body.stage !== undefined) {
    if (!isStage(body.stage)) return c.json({ error: "invalid_stage" }, 400);
    if (body.stage !== cur.stage) {
      if (!isLegalTransition(cur.stage as Stage, body.stage)) {
        return c.json({ error: "illegal_transition", from: cur.stage, to: body.stage }, 400);
      }
      nextStage = body.stage;
    }
  }

  await c.env.DB.prepare(
    `UPDATE founder_pipeline_investors SET
       stage         = COALESCE(?, stage),
       next_step     = COALESCE(?, next_step),
       notes         = COALESCE(?, notes),
       last_touch_at = COALESCE(?, last_touch_at),
       updated_at    = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(
    nextStage,
    body.next_step ?? null,
    body.notes ?? null,
    body.last_touch_at ?? null,
    cur.id,
  ).run();

  if (nextStage) {
    await c.env.DB.prepare(
      `INSERT INTO founder_pipeline_events (id, pipeline_id, pipeline_investor_id, from_stage, to_stage)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(`fpe_${crypto.randomUUID()}`, row.id, cur.id, cur.stage, nextStage).run();
  }
  return c.json({ ok: true, stage: nextStage ?? cur.stage });
});

// ── Suggested next investors via Task #4 intro routing ──────────────

founderCrmRoute.get("/founder-pipelines/:id/suggestions", async (c) => {
  const { row, forbidden } = await loadOwnedPipeline(c.env, c.req.param("id"), c.var.email, c.var.is_admin);
  if (forbidden) return c.json({ error: "forbidden" }, 403);
  if (!row) return c.json({ error: "pipeline_not_found" }, 404);
  const limitRaw = Number(c.req.query("limit") ?? "5");
  const limit = Number.isFinite(limitRaw) ? Math.min(20, Math.max(1, Math.trunc(limitRaw))) : 5;
  const founderEntityId = typeof row.founder_entity_id === "string" ? row.founder_entity_id : null;
  const items = await buildSuggestions(c.env, row.id, founderEntityId, limit);
  return c.json({ items, founder_entity_id: founderEntityId });
});

// ── Public investor reputation projection ───────────────────────────

founderCrmRoute.get("/investors/:id/reputation", async (c) => {
  const investorId = c.req.param("id");
  const raw = await c.env.DB.prepare(
    `SELECT investor_entity_id, speed_to_no_days_median, term_aggressiveness_pct,
            follow_on_rate_pct, board_behavior_score, founder_nps,
            reneged_term_sheets_count, portfolio_conflict_count,
            sample_size, speed_to_no_n, follow_on_n,
            is_public, low_sample, computed_at
       FROM investor_reputation WHERE investor_entity_id = ?`,
  ).bind(investorId).first<RawReputationRow>();
  if (!raw) return c.json({ error: "no_reputation_yet", investor_entity_id: investorId }, 404);
  // Admin callers bypass the min-sample redaction.
  if (c.var.is_admin) {
    return c.json({
      ...raw,
      is_public: raw.is_public === 1,
      low_sample: raw.low_sample === 1,
      admin_view: true,
    });
  }
  return c.json(projectPublicReputation(raw));
});
