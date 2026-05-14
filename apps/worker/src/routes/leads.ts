import { Hono } from "hono";
import type { Env } from "../types";

export const leads = new Hono<{ Bindings: Env; Variables: { email: string } }>();

leads.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const status = c.req.query("status");
  const stmt = status
    ? c.env.DB.prepare("SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(status, limit)
    : c.env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT ?").bind(limit);
  const r = await stmt.all();
  return c.json({ items: r.results ?? [] });
});

leads.get("/:id", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

leads.post("/:id/approve", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE leads SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?")
    .bind(new Date().toISOString(), c.get("email"), id)
    .run();
  return c.json({ ok: true });
});
