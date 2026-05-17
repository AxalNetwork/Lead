// Task #6: operator comments on a person's dossier (right-rail thread).
//
//   GET    /api/profile-comments/:entity_id             — list (non-deleted)
//   POST   /api/profile-comments/:entity_id { body }    — append; 1-2000 chars
//   DELETE /api/profile-comments/:entity_id/:comment_id — soft-delete; author
//                                                         or operator only
//
// Single-tenant workspace. accessGuard already enforces the email allowlist;
// we re-check author identity on DELETE so a future multi-operator setup
// (more than one ALLOWED_EMAIL) doesn't accidentally let one operator
// rewrite another's notes.

import { Hono } from "hono";
import type { Env } from "../types";

export const profileComments = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const MAX_BODY = 2000;

profileComments.get("/:entity_id", async (c) => {
  const entityId = c.req.param("entity_id");
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT id, author_email, body, created_at
       FROM profile_comments
      WHERE entity_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 200`,
  ).bind(entityId).all<{ id: string; author_email: string; body: string; created_at: string }>();
  return c.json({ entity_id: entityId, items: rows.results ?? [] });
});

profileComments.post("/:entity_id", async (c) => {
  const entityId = c.req.param("entity_id");
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  const text = (body?.body ?? "").trim();
  if (!text) return c.json({ error: "body_required" }, 400);
  if (text.length > MAX_BODY) {
    return c.json({ error: "body_too_long", max: MAX_BODY }, 400);
  }
  const id = crypto.randomUUID();
  const author = c.var.email || "unknown";
  await c.env.DB.prepare(
    `INSERT INTO profile_comments (id, entity_id, author_email, body, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).bind(id, entityId, author, text).run();
  return c.json({ ok: true, id, author_email: author, body: text }, 201);
});

profileComments.delete("/:entity_id/:comment_id", async (c) => {
  const entityId = c.req.param("entity_id");
  const commentId = c.req.param("comment_id");
  if (!entityId || !commentId) return c.json({ error: "bad_request" }, 400);
  const caller = (c.var.email || "").toLowerCase();
  const allowed = (c.env.ALLOWED_EMAIL || "").toLowerCase();
  const isOperator = Boolean(caller) && caller === allowed;
  const row = await c.env.DB.prepare(
    `SELECT author_email FROM profile_comments WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`,
  ).bind(commentId, entityId).first<{ author_email: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!isOperator && row.author_email.toLowerCase() !== caller) {
    return c.json({ error: "forbidden" }, 403);
  }
  await c.env.DB.prepare(
    `UPDATE profile_comments SET deleted_at = datetime('now') WHERE id = ?`,
  ).bind(commentId).run();
  return c.json({ ok: true });
});
