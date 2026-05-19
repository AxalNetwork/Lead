// Task #4 routes:
//   POST /api/intros/find             { target_entity_id, ask_context, max_paths?, viewer_entity_id? }
//   POST /api/intros/:path_id/log-outcome { status, notes? }
//
// Both sit behind the existing /api/* access guard (mounted in
// src/index.ts) so the operator email is on c.var.email.

import { Hono } from "hono";
import type { Env } from "../types";
import { insertFact } from "../entities/facts";
import { buildAdjacency, findKShortestPaths } from "../services/intros/pathfinder";
import { extractFeatures } from "../services/intros/features";
import { predict, type ModelWeights } from "../services/intros/model";
import { draftOpener } from "../services/intros/opener";
import {
  loadDisplayNames,
  loadEdgeSignals,
  loadInfluenceMap,
  loadNeighborhood,
  loadTargetHooks,
} from "../services/intros/graph";
import { loadCurrentWeights } from "../services/intros/train";
import { decideByTargetScope, decideOutcomeAccess } from "../services/intros/authz";

const VALID_STATUSES = new Set([
  "requested", "made", "accepted", "declined", "ghosted", "meeting_held", "deal_closed",
]);
const MAX_PATHS_CAP = 10;

export const introsRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

introsRoute.post("/find", async (c) => {
  let body: {
    target_entity_id?: string;
    ask_context?: string;
    max_paths?: number;
    viewer_entity_id?: string;
  };
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }

  const target = body.target_entity_id?.trim();
  if (!target) return c.json({ error: "target_entity_id_required" }, 400);
  const ask = (body.ask_context ?? "").toString().slice(0, 1000);
  const max_paths = Math.min(MAX_PATHS_CAP, Math.max(1, Number(body.max_paths ?? 3)));
  const viewerEntity = body.viewer_entity_id?.trim() || null;
  const viewerEmail = c.var.email || null;

  // Resolve viewer node id: prefer explicit viewer_entity_id; else look
  // up the entity associated with the caller's email (via u_entities.primary_email_key).
  let viewerNode = viewerEntity;
  if (!viewerNode && viewerEmail) {
    try {
      const r = await c.env.DB.prepare(
        `SELECT id FROM u_entities WHERE primary_email_key = LOWER(?) LIMIT 1`,
      ).bind(viewerEmail).first<{ id: string }>();
      if (r?.id) viewerNode = r.id;
    } catch { /* u_entities absent — viewerNode stays null */ }
  }
  if (!viewerNode) {
    return c.json({
      error: "viewer_unresolved",
      detail: "Pass viewer_entity_id or sign in as a user with a matching u_entities row.",
    }, 400);
  }
  if (viewerNode === target) {
    return c.json({ error: "viewer_equals_target" }, 400);
  }

  // Load bounded neighborhood graph.
  const graph = await loadNeighborhood(c.env, viewerNode, target);
  const adj = buildAdjacency(graph.edges);

  // Ranking mode: if every edge between viewer and target's reachable
  // subgraph lacks quality_score, fall back to hop-count-only and
  // mark the response so operators know we're not faking confidence.
  const scoredEdges = graph.edges.filter((e) => typeof e.quality === "number");
  const ranking_mode: "weighted" | "hop_count_only" = scoredEdges.length > 0 ? "weighted" : "hop_count_only";

  const paths = findKShortestPaths(adj, viewerNode, target, {
    max_hops: 3,
    k: max_paths,
    ranking_mode,
    neighbor_cap: 200,
  });

  if (!paths.length) {
    return c.json({
      viewer_entity_id: viewerNode,
      target_entity_id: target,
      ranking_mode,
      truncated: graph.truncated,
      paths: [],
    });
  }

  // Load context for features.
  const pathNodes = Array.from(new Set(paths.flatMap((p) => p.nodes)));
  const [influence, hooks, names] = await Promise.all([
    loadInfluenceMap(c.env, pathNodes),
    loadTargetHooks(c.env, target),
    loadDisplayNames(c.env, pathNodes),
  ]);

  const { weights, model_id } = await loadCurrentWeights(c.env);

  // Score + persist each path.
  const results = [] as Array<Record<string, unknown>>;
  for (const p of paths) {
    const features = extractFeatures(p, ask, {
      target_pagerank: influence.pagerank[target] ?? null,
      broker_scores: Object.fromEntries(p.nodes.map((n) => [n, influence.broker[n] ?? null])),
      target_hooks: hooks,
    });
    // Predict only when in weighted mode — for hop-count-only we
    // explicitly null the prediction rather than fake a number.
    const predicted = ranking_mode === "weighted" ? predict(weights, features) : null;

    // Opener uses the first-hop edge's signals when available.
    const firstHopId = p.nodes[1] ?? null;
    const firstHopEdgeId = p.hops[0]?.edge_id ?? null;
    const edgeSignals = firstHopEdgeId ? await loadEdgeSignals(c.env, firstHopEdgeId) : null;
    const opener = await draftOpener(c.env as { OPENAI_API_KEY?: string }, {
      viewer_name: names[viewerNode] ?? null,
      first_hop_name: firstHopId ? names[firstHopId] ?? null : null,
      target_name: names[target] ?? null,
      ask_context: ask,
      edge_signals: edgeSignals,
    });

    const pathRowId = crypto.randomUUID();
    const pathJson = p.nodes.map((nodeId, i) => ({
      entity_id: nodeId,
      display_name: names[nodeId] ?? null,
      edge_id: i === 0 ? null : p.hops[i - 1].edge_id,
      edge_kind: i === 0 ? null : p.hops[i - 1].edge_kind,
      edge_quality: i === 0 ? null : p.hops[i - 1].quality,
    }));

    try {
      await c.env.DB.prepare(
        `INSERT INTO intro_paths (
          id, viewer_entity_id, viewer_email, target_entity_id, ask_context,
          hops, path_json, first_hop_entity_id, weakest_edge_quality,
          predicted_conversion_pct, features_json, suggested_opener,
          model_version, ranking_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        pathRowId,
        viewerNode, viewerEmail, target, ask,
        p.hops.length, JSON.stringify(pathJson), firstHopId, p.weakest_edge_quality,
        predicted, JSON.stringify(features), opener,
        model_id, ranking_mode,
      ).run();
    } catch (e) {
      console.warn("intro_paths insert failed", (e as Error).message);
    }

    // Mirror the predicted-conversion snapshot onto the TARGET entity
    // via insertFact per Task #1 canonical write contract. Only when
    // we actually have a prediction.
    if (predicted != null) {
      try {
        await insertFact(c.env, {
          entity_id: target,
          predicate: "entity.intro_predicted_conversion_pct",
          value_number: predicted,
          value_json: { path_id: pathRowId, hops: p.hops.length, viewer: viewerNode },
          source_kind: "inferred",
          source: "intro_router",
          confidence: 0.6,
        });
      } catch (e) {
        console.warn("intro insertFact failed", (e as Error).message);
      }
    }

    results.push({
      path_id: pathRowId,
      hops: p.hops.length,
      path: pathJson,
      weakest_edge_quality: p.weakest_edge_quality,
      predicted_conversion_pct: predicted,
      features,
      suggested_opener: opener,
      ranking_mode,
    });
  }

  return c.json({
    viewer_entity_id: viewerNode,
    target_entity_id: target,
    ranking_mode,
    model_version: model_id,
    truncated: graph.truncated,
    paths: results,
  });
});

introsRoute.post("/:path_id/log-outcome", async (c) => {
  const path_id = c.req.param("path_id");
  if (!path_id) return c.json({ error: "bad_request" }, 400);
  let body: { status?: string; notes?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const status = (body.status ?? "").toString().trim();
  if (!VALID_STATUSES.has(status)) {
    return c.json({ error: "invalid_status", allowed: Array.from(VALID_STATUSES) }, 400);
  }
  // Owner-or-admin gate: only the operator who originally requested
  // the path (intro_paths.viewer_email) may log outcomes against it.
  // Admins (per accessGuard) can override. Anyone else gets 403 —
  // unauthorized writes would poison the nightly retrain labels.
  const row = await c.env.DB.prepare(
    `SELECT id, viewer_email FROM intro_paths WHERE id = ?`,
  ).bind(path_id).first<{ id: string; viewer_email: string | null }>();
  if (!row) return c.json({ error: "path_not_found" }, 404);
  const access = decideOutcomeAccess(c.var.email, row.viewer_email, c.var.is_admin === true);
  if (!access.allowed) return c.json({ error: "forbidden" }, 403);

  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO intro_outcomes (id, path_id, status, logged_by, notes) VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, path_id, status, c.var.email ?? null, body.notes ?? null).run();
  } catch (e) {
    return c.json({ error: "insert_failed", detail: (e as Error).message }, 500);
  }
  return c.json({ id, path_id, status, ok: true });
});

// Read endpoints — handy for the Profile Outreach tab and ops dashboards.

introsRoute.get("/model/current", async (c) => {
  const { weights, model_id } = await loadCurrentWeights(c.env);
  let brier: number | null = null;
  let sample_size = 0;
  let trained_at: string | null = null;
  if (model_id) {
    try {
      const r = await c.env.DB.prepare(
        `SELECT brier_score, sample_size, trained_at FROM intro_model_runs WHERE id = ?`,
      ).bind(model_id).first<{ brier_score: number | null; sample_size: number; trained_at: string }>();
      if (r) { brier = r.brier_score; sample_size = r.sample_size; trained_at = r.trained_at; }
    } catch { /* leave defaults */ }
  }
  return c.json({
    model_id,
    weights: weights as ModelWeights,
    brier_score: brier,
    sample_size,
    trained_at,
  });
});

// Per-target recent paths (used by Profile Outreach tab when the
// operator wants to surface previously surfaced intros for this target).
introsRoute.get("/by-target/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "bad_request" }, 400);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "10")));
  // Owner-scoped read: non-admin callers see only their own path
  // history for this target. Admins see all rows. The `viewer_email`
  // column is omitted from the non-admin projection to avoid leaking
  // other operators' identities even when filtered.
  const scopeDecision = decideByTargetScope(c.var.email, c.var.is_admin === true);
  try {
    if (scopeDecision.scope === "admin") {
      const r = await c.env.DB.prepare(
        `SELECT id, viewer_email, hops, predicted_conversion_pct, weakest_edge_quality,
                suggested_opener, ranking_mode, created_at
           FROM intro_paths
          WHERE target_entity_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      ).bind(id, limit).all();
      return c.json({ target_entity_id: id, items: r.results ?? [], scope: "admin" });
    }
    if (!scopeDecision.filter_owner_email) return c.json({ target_entity_id: id, items: [], scope: "owner" });
    const r = await c.env.DB.prepare(
      `SELECT id, hops, predicted_conversion_pct, weakest_edge_quality,
              suggested_opener, ranking_mode, created_at
         FROM intro_paths
        WHERE target_entity_id = ? AND LOWER(viewer_email) = LOWER(?)
        ORDER BY created_at DESC
        LIMIT ?`,
    ).bind(id, scopeDecision.filter_owner_email, limit).all();
    return c.json({ target_entity_id: id, items: r.results ?? [], scope: "owner" });
  } catch {
    return c.json({ target_entity_id: id, items: [] });
  }
});
