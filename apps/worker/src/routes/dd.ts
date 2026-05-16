// Task #3: Due-diligence API surface.
//
//   POST /api/dd/scan/:entityId            run a scan (sync, ~5-30s)
//   POST /api/dd/scan/:entityId/dispatch   queue a workflow scan (returns wf id)
//   POST /api/dd/scan/batch                run batch scan of due entities
//   GET  /api/dd/findings?entity=&type=&status=&severity=
//   PATCH /api/dd/findings/:id             review (confirm/false_positive/resolve/notes)
//   GET  /api/dd/scores?band=&limit=       paginate by risk_band
//   GET  /api/dd/scores/:entityId          single entity score + summary
//   GET  /api/dd/queue                     review queue (open critical/high)
//   GET  /api/dd/watchlist-cache           list of cached snapshots
//   POST /api/dd/watchlist-refresh         force a refresh (manual)
//   GET  /api/dd/scan-runs?entity=         scan history

import { Hono } from "hono";
import type { Env } from "../types";
import { scanEntity, loadEntityForScan } from "../dd/scan";
import { refreshAllWatchlists, batchScanDueEntities } from "../dd/watchlistRefresh";

export const ddRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

// ---- Scan ----

ddRoute.post("/scan/:entityId", async (c) => {
  const id = Number(c.req.param("entityId"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const ent = await loadEntityForScan(c.env, id);
  if (!ent) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { providers?: string[]; enableAi?: boolean; matchThreshold?: number };
  try {
    const out = await scanEntity(c.env, ent, {
      trigger: "manual",
      triggered_by: c.get("email"),
      providers: Array.isArray(body.providers) ? body.providers : undefined,
      enableAi: body.enableAi !== false,
      matchThreshold: typeof body.matchThreshold === "number" ? body.matchThreshold : undefined,
    });
    return c.json(out);
  } catch (e) {
    return c.json({ error: "scan_failed", message: (e as Error).message }, 500);
  }
});

ddRoute.post("/scan/:entityId/dispatch", async (c) => {
  const id = Number(c.req.param("entityId"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  if (c.env.WF_DD_SCAN_ENTITY) {
    try {
      const wf = await c.env.WF_DD_SCAN_ENTITY.create({ params: { entityId: id, triggered_by: c.get("email") } });
      return c.json({ ok: true, workflow_id: wf.id, dispatched: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  }
  // Fall back to inline scan when WF binding isn't available (dev).
  const ent = await loadEntityForScan(c.env, id);
  if (!ent) return c.json({ error: "not_found" }, 404);
  const out = await scanEntity(c.env, ent, { trigger: "manual", triggered_by: c.get("email") });
  return c.json({ ok: true, dispatched: false, ...out });
});

ddRoute.post("/scan/batch", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number; staleDays?: number };
  const limit = Math.min(Number(body.limit ?? 50), 500);
  if (c.env.WF_DD_SCAN_BATCH) {
    try {
      const wf = await c.env.WF_DD_SCAN_BATCH.create({ params: { limit, staleDays: body.staleDays ?? 7 } });
      return c.json({ ok: true, workflow_id: wf.id, dispatched: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  }
  const out = await batchScanDueEntities(c.env, { limit, staleDays: body.staleDays });
  return c.json({ ok: true, dispatched: false, ...out });
});

// ---- Findings ----

ddRoute.get("/findings", async (c) => {
  const entity = c.req.query("entity");
  const type = c.req.query("type");
  const status = c.req.query("status");
  const severity = c.req.query("severity");
  const limit = Math.min(Number(c.req.query("limit") ?? "200"), 1000);
  const where: string[] = ["1=1"];
  const args: Array<string | number> = [];
  if (entity) { where.push("entity_id = ?"); args.push(Number(entity)); }
  if (type) { where.push("finding_type = ?"); args.push(type); }
  if (status) { where.push("status = ?"); args.push(status); }
  if (severity) { where.push("severity = ?"); args.push(severity); }
  const sql = `SELECT id, entity_id, finding_type, finding_subtype, source_provider, source_url,
                      match_score, match_method, title, description, severity, status,
                      reviewed_by, reviewed_at, reviewer_notes, observed_at, created_at
                 FROM dd_findings
                WHERE ${where.join(" AND ")}
                ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                         observed_at DESC
                LIMIT ?`;
  args.push(limit);
  const r = await c.env.DB.prepare(sql).bind(...args).all();
  return c.json({ items: r.results ?? [] });
});

ddRoute.patch("/findings/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const body = (await c.req.json().catch(() => null)) as { status?: string; reviewer_notes?: string; severity?: string } | null;
  if (!body) return c.json({ error: "bad_body" }, 400);
  // Validate enums up-front and reject unknown values with 400 so clients
  // get a clear error rather than a silent no-op update.
  const VALID_STATUS = ["open","confirmed","false_positive","resolved"] as const;
  const VALID_SEVERITY = ["low","medium","high","critical"] as const;
  if (body.status !== undefined && !VALID_STATUS.includes(body.status as typeof VALID_STATUS[number])) {
    return c.json({ error: "bad_status", allowed: VALID_STATUS }, 400);
  }
  if (body.severity !== undefined && !VALID_SEVERITY.includes(body.severity as typeof VALID_SEVERITY[number])) {
    return c.json({ error: "bad_severity", allowed: VALID_SEVERITY }, 400);
  }
  const sets: string[] = ["updated_at = ?"];
  const args: Array<string | number> = [new Date().toISOString()];
  if (body.status) {
    sets.push("status = ?"); args.push(body.status);
    sets.push("reviewed_by = ?"); args.push(c.get("email"));
    sets.push("reviewed_at = ?"); args.push(new Date().toISOString());
  }
  if (typeof body.reviewer_notes === "string") { sets.push("reviewer_notes = ?"); args.push(body.reviewer_notes.slice(0, 4000)); }
  if (body.severity) { sets.push("severity = ?"); args.push(body.severity); }
  args.push(id);
  const r = await c.env.DB.prepare(`UPDATE dd_findings SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  if (Number(r.meta?.changes ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  // Recompute score if review changed status (best-effort).
  if (body.status) {
    const row = await c.env.DB.prepare(`SELECT entity_id FROM dd_findings WHERE id = ?`).bind(id).first<{ entity_id: number }>();
    if (row) {
      const all = await c.env.DB.prepare(`SELECT finding_type, severity, status, match_score FROM dd_findings WHERE entity_id = ?`).bind(row.entity_id).all();
      const { computeScores } = await import("../dd/score");
      const s = computeScores((all.results as unknown as Parameters<typeof computeScores>[0]) ?? []);
      const now = new Date().toISOString();
      await c.env.DB.prepare(
        `UPDATE entity_risk_scores SET risk_score=?, trust_score=?, risk_band=?,
          sanctions_count=?, pep_count=?, adverse_media_count=?, court_case_count=?,
          enforcement_count=?, green_flag_count=?, components_json=?, updated_at=?
        WHERE entity_id = ?`,
      ).bind(
        s.risk_score, s.trust_score, s.risk_band,
        s.counts.sanctions_count, s.counts.pep_count, s.counts.adverse_media_count,
        s.counts.court_case_count, s.counts.enforcement_count, s.counts.green_flag_count,
        JSON.stringify(s.components), now, row.entity_id,
      ).run();
    }
  }
  return c.json({ ok: true });
});

// ---- Scores ----

ddRoute.get("/scores", async (c) => {
  const band = c.req.query("band");
  const limit = Math.min(Number(c.req.query("limit") ?? "200"), 1000);
  const where: string[] = ["1=1"];
  const args: Array<string | number> = [];
  if (band) { where.push("r.risk_band = ?"); args.push(band); }
  const sql = `SELECT r.*, e.name AS entity_name, e.kind AS entity_kind
                 FROM entity_risk_scores r
                 JOIN entities e ON e.id = r.entity_id
                WHERE ${where.join(" AND ")}
                ORDER BY r.risk_score DESC LIMIT ?`;
  args.push(limit);
  const r = await c.env.DB.prepare(sql).bind(...args).all();
  return c.json({ items: r.results ?? [] });
});

ddRoute.get("/scores/:entityId", async (c) => {
  const id = Number(c.req.param("entityId"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad_id" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT r.*, e.name AS entity_name, e.kind AS entity_kind
       FROM entity_risk_scores r JOIN entities e ON e.id = r.entity_id
      WHERE r.entity_id = ?`,
  ).bind(id).first();
  if (!row) return c.json({ error: "not_scanned" }, 404);
  return c.json(row);
});

// ---- Review queue ----

ddRoute.get("/queue", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const r = await c.env.DB.prepare(
    `SELECT f.id, f.entity_id, e.name AS entity_name, e.kind AS entity_kind,
            f.finding_type, f.finding_subtype, f.severity, f.status,
            f.source_provider, f.source_url, f.title, f.match_score,
            f.observed_at, r.risk_score, r.risk_band
       FROM dd_findings f
       JOIN entities e ON e.id = f.entity_id
       LEFT JOIN entity_risk_scores r ON r.entity_id = f.entity_id
      WHERE f.status = 'open'
        AND f.severity IN ('high','critical')
      ORDER BY CASE f.severity WHEN 'critical' THEN 2 ELSE 1 END DESC,
               COALESCE(r.risk_score, 0) DESC,
               f.observed_at DESC
      LIMIT ?`,
  ).bind(limit).all();
  return c.json({ items: r.results ?? [] });
});

// ---- Watchlist cache ----

ddRoute.get("/watchlist-cache", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT provider, list_name, snapshot_date, record_count, ok, error, fetched_at, duration_ms
       FROM dd_watchlist_cache
      ORDER BY fetched_at DESC LIMIT 100`,
  ).all();
  return c.json({ items: r.results ?? [] });
});

ddRoute.post("/watchlist-refresh", async (c) => {
  try {
    const out = await refreshAllWatchlists(c.env);
    return c.json({ ok: true, ...out });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// ---- Scan runs ----

ddRoute.get("/scan-runs", async (c) => {
  const entity = c.req.query("entity");
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 500);
  if (entity) {
    const r = await c.env.DB.prepare(
      `SELECT * FROM dd_scan_runs WHERE entity_id = ? ORDER BY started_at DESC LIMIT ?`,
    ).bind(Number(entity), limit).all();
    return c.json({ items: r.results ?? [] });
  }
  const r = await c.env.DB.prepare(
    `SELECT s.*, e.name AS entity_name FROM dd_scan_runs s JOIN entities e ON e.id = s.entity_id ORDER BY started_at DESC LIMIT ?`,
  ).bind(limit).all();
  return c.json({ items: r.results ?? [] });
});
