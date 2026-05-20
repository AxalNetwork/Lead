// Task #1: Garbage Entity Review console — admin-only.
//
// All routes inherit `accessGuard` + `adminOnly` from the parent mount
// (`/api/ops/*`) in index.ts. Reads list soft-deleted entities flagged
// by the garbage detector; writes restore or permanently purge with
// an audit row in `data_quality_log` (issue='restored'|'purged').
//
// Per the /ops/crawler/ gating constraint: the static Jekyll page
// can't enforce 403 — it pre-flights GET / and reveals content only
// when the worker-side adminOnly admits the request.

import { Hono } from "hono";
import type { Env } from "../types";
import { restoreEntity, purgeEntity, runCleanupSweep } from "../entities/garbage";

type Vars = { email: string; is_admin: boolean };

export const opsGarbageRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

interface SoftDeletedRow {
  id: string;
  kind: string;
  display_name: string | null;
  primary_url: string | null;
  primary_domain: string | null;
  status: string;
  deleted_reason: string | null;
  created_at: string;
  updated_at: string;
}

// GET /api/ops/garbage-review/  — index probe (used by the page's
// pre-flight). Returns soft-delete counts so the page knows whether
// there's anything to show. Also unblocks the page reveal.
opsGarbageRoute.get("/", async (c) => {
  let totalSoftDeleted = 0;
  let last24h = 0;
  let totalLog = 0;
  try {
    const r = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM u_entities WHERE status = 'soft_deleted'`,
    ).first<{ n: number }>();
    totalSoftDeleted = Number(r?.n ?? 0);
  } catch { /* table may not exist on fresh deploys */ }
  try {
    const r = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM u_entities
        WHERE status = 'soft_deleted' AND updated_at >= datetime('now','-1 day')`,
    ).first<{ n: number }>();
    last24h = Number(r?.n ?? 0);
  } catch { /* ignore */ }
  try {
    const r = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM data_quality_log`,
    ).first<{ n: number }>();
    totalLog = Number(r?.n ?? 0);
  } catch { /* ignore */ }
  return c.json({
    ok: true,
    soft_deleted_total: totalSoftDeleted,
    soft_deleted_last_24h: last24h,
    audit_log_rows: totalLog,
  });
});

// GET /api/ops/garbage-review/list?limit=&offset=&q=  — paginated list
// of soft-deleted entities with reason + source URL.
opsGarbageRoute.get("/list", async (c) => {
  const url = new URL(c.req.url);
  const limRaw = Number(url.searchParams.get("limit") ?? "50");
  const offRaw = Number(url.searchParams.get("offset") ?? "0");
  const limit = Math.min(Math.max(1, Math.floor(Number.isFinite(limRaw) ? limRaw : 50)), 200);
  const offset = Math.max(0, Math.floor(Number.isFinite(offRaw) ? offRaw : 0));
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const where: string[] = ["status = 'soft_deleted'"];
  const binds: unknown[] = [];
  if (q) {
    where.push("(lower(display_name) LIKE ? OR lower(primary_domain) LIKE ? OR lower(primary_url) LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, kind, display_name, primary_url, primary_domain, status,
              deleted_reason, created_at, updated_at
         FROM u_entities
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    ).bind(...binds, limit + 1, offset).all<SoftDeletedRow>();
    const items = rows.results ?? [];
    const hasMore = items.length > limit;
    return c.json({
      items: hasMore ? items.slice(0, limit) : items,
      nextOffset: hasMore ? offset + limit : null,
    });
  } catch (e) {
    console.warn("ops_garbage list failed", (e as Error).message);
    return c.json({ items: [], nextOffset: null, error: "list_failed" });
  }
});

// GET /api/ops/garbage-review/:id  — full detail incl. audit history.
opsGarbageRoute.get("/entity/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  let entity: SoftDeletedRow | null = null;
  try {
    entity = await c.env.DB.prepare(
      `SELECT id, kind, display_name, primary_url, primary_domain, status,
              deleted_reason, created_at, updated_at
         FROM u_entities WHERE id = ?`,
    ).bind(id).first<SoftDeletedRow>();
  } catch { /* ignore */ }
  if (!entity) return c.json({ error: "not_found" }, 404);
  let log: Array<Record<string, unknown>> = [];
  try {
    const r = await c.env.DB.prepare(
      `SELECT id, issue, reasons_json, source, actor_email, detected_at
         FROM data_quality_log WHERE entity_id = ?
        ORDER BY detected_at DESC LIMIT 50`,
    ).bind(id).all<Record<string, unknown>>();
    log = r.results ?? [];
  } catch { /* table may not exist */ }
  return c.json({ entity, audit_log: log });
});

// POST /api/ops/garbage-review/:id/restore  — flip back to active.
opsGarbageRoute.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  const actor = c.var.email || "unknown";
  try {
    await restoreEntity(c.env, id, actor);
    return c.json({ ok: true, action: "restored", id });
  } catch (e) {
    console.warn("ops_garbage restore failed", id, (e as Error).message);
    return c.json({ error: "restore_failed", message: (e as Error).message }, 500);
  }
});

// POST /api/ops/garbage-review/:id/purge  — permanent delete + cascade.
opsGarbageRoute.post("/:id/purge", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  const actor = c.var.email || "unknown";
  try {
    await purgeEntity(c.env, id, actor);
    return c.json({ ok: true, action: "purged", id });
  } catch (e) {
    console.warn("ops_garbage purge failed", id, (e as Error).message);
    return c.json({ error: "purge_failed", message: (e as Error).message }, 500);
  }
});

// POST /api/ops/garbage-review/cleanup-now  — manual sweep trigger.
// Supports ?mode=recent|all and ?limit=. Used by ops to perform the
// one-off full-scan cleanup pass post-deploy (see migration 375
// preamble), and to re-run the sweep on demand. Bounded at 5000.
opsGarbageRoute.post("/cleanup-now", async (c) => {
  const url = new URL(c.req.url);
  const mode = url.searchParams.get("mode") === "all" ? "all" : "recent";
  const lookbackHours = Number(url.searchParams.get("lookback_hours") ?? "6");
  const limit = Math.min(
    Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? "5000"))),
    5000,
  );
  const actor = c.var.email || "unknown";
  try {
    const result = await runCleanupSweep(c.env, {
      mode, lookbackHours, limit, source: "operator", actorEmail: actor,
      skipAi: url.searchParams.get("skip_ai") === "1",
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.warn("ops_garbage cleanup-now failed", (e as Error).message);
    return c.json({ error: "sweep_failed", message: (e as Error).message }, 500);
  }
});
