import { Hono } from "hono";
import type { Env, JobMessage } from "../types";

export const discover = new Hono<{ Bindings: Env; Variables: { email: string } }>();

// Kick off a discovery job. Body: { firmDomain?: string, persona?: string, country?: string }
discover.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { firmDomain?: string; persona?: string; country?: string; name?: string }
    | null;
  if (!body || (!body.firmDomain && !body.persona)) {
    return c.json({ error: "bad_request", message: "firmDomain or persona required" }, 400);
  }
  const target = body.firmDomain ?? body.persona ?? "";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const config = body.firmDomain
    ? { mode: "firm", firmDomain: body.firmDomain }
    : { mode: "persona", persona: body.persona, country: body.country };
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'discover', ?, ?, ?, ?)`,
  )
    .bind(id, body.name ?? `discover:${target}`, target, target, JSON.stringify(config), now, now)
    .run();
  const msg: JobMessage = { jobId: id, kind: "discover", target, config };
  await c.env.LEAD_QUEUE.send(msg);
  return c.json({ jobId: id, status: "queued" }, 201);
});

// List candidates with optional filters.
discover.get("/candidates", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const status = c.req.query("status") ?? "pending";
  const firm = c.req.query("firmDomain");
  const wheres: string[] = ["status = ?"];
  const binds: unknown[] = [status];
  if (firm) { wheres.push("firm_domain = ?"); binds.push(firm); }
  const r = await c.env.DB
    .prepare(
      `SELECT id, job_id, firm_domain, query, source, url, title, snippet, name, org, persona_role, status, resolved_lead_id, created_at, resolved_at
       FROM discovery_candidates WHERE ${wheres.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...binds, limit)
    .all();
  return c.json({ items: r.results ?? [] });
});

// Approve a candidate → enqueue a kind='url' scrape on the candidate URL and
// flip the row to 'resolved'. The actual lead row is created by the scraper
// pipeline once the page is parsed.
discover.post("/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB
    .prepare("SELECT * FROM discovery_candidates WHERE id = ?")
    .bind(id)
    .first<{ id: string; url: string; firm_domain: string | null; status: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "pending") return c.json({ error: "already_resolved", status: row.status }, 409);

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  let source = row.firm_domain ?? "";
  try { source = new URL(row.url).hostname.toLowerCase(); } catch { /* keep firm_domain */ }
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'url', ?, ?, ?, ?)`,
  )
    .bind(jobId, `resolve:${id}`, source, row.url, JSON.stringify({ candidate_id: id }), now, now)
    .run();
  await c.env.LEAD_QUEUE.send({ jobId, kind: "url", target: row.url });
  await c.env.DB
    .prepare("UPDATE discovery_candidates SET status = 'resolved', resolved_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
  return c.json({ ok: true, jobId });
});

discover.post("/:id/reject", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB
    .prepare("UPDATE discovery_candidates SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'")
    .bind(new Date().toISOString(), id)
    .run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});
