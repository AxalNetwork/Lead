import { Hono } from "hono";
import type { Env, JobKind, JobMessage } from "../types";
import { tosBlockedReason } from "../scraper/tos";

export const jobs = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const ALLOWED_KINDS: JobKind[] = ["url", "linktree", "profile_list", "discover", "firmlist", "firm_team_crawl"];

function isJobKind(k: unknown): k is JobKind {
  return typeof k === "string" && (ALLOWED_KINDS as string[]).includes(k);
}

jobs.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { kind?: unknown; target?: unknown; config?: unknown; name?: unknown }
    | null;
  if (!body || !isJobKind(body.kind) || typeof body.target !== "string" || !body.target.trim()) {
    return c.json({ error: "bad_request", message: "kind and target required" }, 400);
  }
  const target = body.target.trim();
  const config = (body.config && typeof body.config === "object" ? body.config : {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name : `${body.kind}:${target}`;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let source = "";
  try {
    source = new URL(target).hostname.toLowerCase();
  } catch {
    source = body.kind;
  }

  // ToS gate at the primary enqueue entrypoint: refuse hosts our policy
  // table flags as off-limits before we touch the DB or queue.
  if (source && source !== body.kind) {
    const tosReason = tosBlockedReason(source);
    if (tosReason) {
      return c.json({ error: "tos_blocked", message: tosReason, host: source }, 403);
    }
  }
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  )
    .bind(id, name, source, body.kind, target, JSON.stringify(config), now, now)
    .run();

  const msg: JobMessage = { jobId: id, kind: body.kind, target, config };
  await c.env.LEAD_QUEUE.send(msg);
  return c.json({ jobId: id, status: "queued" }, 201);
});

jobs.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const statusParam = c.req.query("status");
  const kind = c.req.query("kind");
  const source = c.req.query("source");

  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (statusParam) {
    const list = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) {
      wheres.push(`status IN (${list.map(() => "?").join(",")})`);
      binds.push(...list);
    }
  }
  if (kind) {
    wheres.push("kind = ?");
    binds.push(kind);
  }
  if (source) {
    wheres.push("source = ?");
    binds.push(source);
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const stmt = c.env.DB.prepare(
    `SELECT id, name, source, kind, target, status, leads_found, pages_fetched, pages_blocked, captcha_hits, cost_ms, started_at, finished_at, cancelled_at, created_at
     FROM jobs ${whereSql} ORDER BY started_at DESC LIMIT ?`,
  ).bind(...binds, limit);
  const r = await stmt.all();
  return c.json({ items: r.results ?? [] });
});

jobs.get("/:id", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

jobs.post("/:id/replay", async (c) => {
  const id = c.req.param("id");
  const job = await c.env.DB.prepare(
    `SELECT id, name, source, kind, target, config_json FROM jobs WHERE id = ?`,
  ).bind(id).first<{ id: string; name: string; source: string; kind: JobKind; target: string; config_json: string | null }>();
  if (!job) return c.json({ error: "not_found" }, 404);
  let config: Record<string, unknown> = {};
  if (job.config_json) { try { config = JSON.parse(job.config_json) as Record<string, unknown>; } catch { /* ignore */ } }
  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at, parent_job_id)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  ).bind(newId, `${job.name} (replay)`, job.source, job.kind, job.target, JSON.stringify(config), now, now, job.id).run();
  await c.env.DB.prepare(
    `INSERT INTO job_state_transitions (job_id, from_state, to_state, reason, changed_by) VALUES (?, NULL, 'queued', ?, ?)`,
  ).bind(newId, `manual replay of ${job.id}`, c.var.email ?? "system").run();
  const msg: JobMessage = { jobId: newId, kind: job.kind, target: job.target, config };
  await c.env.LEAD_QUEUE.send(msg);
  return c.json({ ok: true, replay_job_id: newId, parent_job_id: job.id }, 201);
});

jobs.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE jobs SET status = 'cancelled', cancelled_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status IN ('queued','running')`,
  )
    .bind(now, now, id)
    .run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});
