// Per-user saved querystrings used by /dashboard/firms (and reusable by
// other entity pages). Owner-only — no cross-tenant reads/writes.
import { Hono } from "hono";
import type { Env } from "../types";

export const savedFilters = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const ALLOWED_ENTITIES = new Set(["firms", "leads", "firm_people", "portfolio"]);

savedFilters.get("/", async (c) => {
  const email = c.get("email");
  const entity = c.req.query("entity");
  if (entity && !ALLOWED_ENTITIES.has(entity)) {
    return c.json({ error: "bad_entity" }, 400);
  }
  const sql = entity
    ? "SELECT id, name, entity, querystring, created_at FROM saved_filters WHERE created_by = ? AND entity = ? ORDER BY name"
    : "SELECT id, name, entity, querystring, created_at FROM saved_filters WHERE created_by = ? ORDER BY entity, name";
  const stmt = entity
    ? c.env.DB.prepare(sql).bind(email, entity)
    : c.env.DB.prepare(sql).bind(email);
  const r = await stmt.all();
  return c.json({ items: r.results ?? [] });
});

savedFilters.post("/", async (c) => {
  const email = c.get("email");
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; entity?: unknown; querystring?: unknown }
    | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "bad_request", message: "name required" }, 400);
  }
  const entity = String(body.entity ?? "");
  if (!ALLOWED_ENTITIES.has(entity)) return c.json({ error: "bad_entity" }, 400);
  const qs = typeof body.querystring === "string" ? body.querystring.replace(/^\?/, "") : "";
  if (qs.length > 4000) return c.json({ error: "querystring_too_long" }, 400);
  try {
    const r = await c.env.DB
      .prepare(
        `INSERT INTO saved_filters (name, entity, querystring, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(created_by, entity, name) DO UPDATE SET querystring = excluded.querystring`,
      )
      .bind(body.name.trim(), entity, qs, email)
      .run();
    const id = (r.meta.last_row_id as number) ?? null;
    return c.json({ ok: true, id, name: body.name.trim(), entity, querystring: qs }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", message: (e as Error).message }, 500);
  }
});

savedFilters.delete("/:id", async (c) => {
  const email = c.get("email");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const r = await c.env.DB
    .prepare("DELETE FROM saved_filters WHERE id = ? AND created_by = ?")
    .bind(id, email)
    .run();
  if (!r.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
