// Watchlists CRUD + member management + smart-list refresh trigger.

import { Hono } from "hono";
import type { Env } from "../types";
import { reevaluateSmartWatchlist } from "../monitoring/smart";

export const watchlists = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function ownerEmail(c: { get: (k: string) => string }) { return c.get("email"); }

watchlists.get("/", async (c) => {
  const email = ownerEmail(c);
  const r = await c.env.DB.prepare(
    `SELECT id, name, description, is_smart, filter_json, entity_kind, member_count,
            last_changed_at, last_evaluated_at, is_default, created_at, updated_at
       FROM watchlists WHERE owner_email = ? ORDER BY is_default DESC, name`,
  ).bind(email).all();
  return c.json({ items: r.results ?? [] });
});

watchlists.post("/", async (c) => {
  const email = ownerEmail(c);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "bad_request", message: "name required" }, 400);
  }
  const id = crypto.randomUUID();
  const isSmart = body.is_smart ? 1 : 0;
  const filterJson = body.filter_json && typeof body.filter_json === "object"
    ? JSON.stringify(body.filter_json) : (typeof body.filter_json === "string" ? body.filter_json : null);
  try {
    await c.env.DB.prepare(
      `INSERT INTO watchlists (id, owner_email, name, description, is_smart, filter_json, entity_kind, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, email, body.name.trim(),
      typeof body.description === "string" ? body.description : null,
      isSmart, filterJson,
      typeof body.entity_kind === "string" ? body.entity_kind : null,
      body.is_default ? 1 : 0,
    ).run();
  } catch (e) {
    return c.json({ error: "insert_failed", message: (e as Error).message }, 400);
  }
  if (isSmart) {
    try { await reevaluateSmartWatchlist(c.env, id, filterJson); } catch { /* ignore */ }
  }
  return c.json({ id, ok: true }, 201);
});

watchlists.get("/:id", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const wl = await c.env.DB.prepare(
    `SELECT * FROM watchlists WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).first();
  if (!wl) return c.json({ error: "not_found" }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const members = await c.env.DB.prepare(
    `SELECT m.entity_id, m.added_at, m.source,
            COALESCE(s.display_name, e.display_name) AS display_name,
            e.kind AS entity_kind, s.primary_employer, s.country_iso2, s.city
       FROM watchlist_members m
       JOIN u_entities e ON e.id = m.entity_id
       LEFT JOIN entity_summary s ON s.entity_id = m.entity_id
      WHERE m.watchlist_id = ?
      ORDER BY m.added_at DESC LIMIT ?`,
  ).bind(id, limit).all();
  const rules = await c.env.DB.prepare(
    `SELECT id, name, trigger_kind, channel, digest_frequency, is_active, fire_count, last_fired_at
       FROM alert_rules WHERE watchlist_id = ? ORDER BY created_at DESC`,
  ).bind(id).all();
  return c.json({ ...wl, members: members.results ?? [], rules: rules.results ?? [] });
});

watchlists.patch("/:id", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  const fields: string[] = [];
  const binds: unknown[] = [];
  for (const k of ["name", "description", "entity_kind"]) {
    if (k in body) { fields.push(`${k} = ?`); binds.push(body[k] ?? null); }
  }
  if ("is_smart" in body) { fields.push("is_smart = ?"); binds.push(body.is_smart ? 1 : 0); }
  if ("filter_json" in body) {
    const fj = typeof body.filter_json === "object" && body.filter_json !== null
      ? JSON.stringify(body.filter_json)
      : (typeof body.filter_json === "string" ? body.filter_json : null);
    fields.push("filter_json = ?"); binds.push(fj);
  }
  if (!fields.length) return c.json({ error: "no_changes" }, 400);
  fields.push("updated_at = datetime('now')");
  const r = await c.env.DB.prepare(
    `UPDATE watchlists SET ${fields.join(", ")} WHERE id = ? AND owner_email = ?`,
  ).bind(...binds, id, email).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

watchlists.delete("/:id", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  // Verify ownership BEFORE cascading deletes — otherwise any authed user
  // could wipe another user's membership rows by guessing the ID.
  const owned = await c.env.DB.prepare(
    `SELECT id FROM watchlists WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).first<{ id: string }>();
  if (!owned) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare(`DELETE FROM watchlist_members WHERE watchlist_id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM alert_rules WHERE watchlist_id = ? AND owner_email = ?`).bind(id, email).run();
  const r = await c.env.DB.prepare(
    `DELETE FROM watchlists WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

watchlists.post("/:id/members", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { entity_ids?: unknown } | null;
  const ids = Array.isArray(body?.entity_ids) ? body!.entity_ids.filter((x) => typeof x === "string") as string[] : [];
  if (!ids.length) return c.json({ error: "bad_request", message: "entity_ids required" }, 400);
  const wl = await c.env.DB.prepare(`SELECT id FROM watchlists WHERE id = ? AND owner_email = ?`).bind(id, email).first();
  if (!wl) return c.json({ error: "not_found" }, 404);
  const now = new Date().toISOString();
  let added = 0;
  for (const eid of ids) {
    try {
      const r = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO watchlist_members (watchlist_id, entity_id, added_at, added_by, source)
           VALUES (?, ?, ?, ?, 'manual')`,
      ).bind(id, eid, now, email).run();
      if (r.meta.changes && r.meta.changes > 0) added++;
    } catch { /* ignore */ }
  }
  await c.env.DB.prepare(
    `UPDATE watchlists SET member_count = (SELECT COUNT(*) FROM watchlist_members WHERE watchlist_id = ?),
       last_changed_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(id, now, now, id).run();
  return c.json({ ok: true, added });
});

watchlists.delete("/:id/members", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { entity_ids?: unknown } | null;
  const ids = Array.isArray(body?.entity_ids) ? body!.entity_ids.filter((x) => typeof x === "string") as string[] : [];
  if (!ids.length) return c.json({ error: "bad_request" }, 400);
  const wl = await c.env.DB.prepare(`SELECT id FROM watchlists WHERE id = ? AND owner_email = ?`).bind(id, email).first();
  if (!wl) return c.json({ error: "not_found" }, 404);
  const placeholders = ids.map(() => "?").join(",");
  const r = await c.env.DB.prepare(
    `DELETE FROM watchlist_members WHERE watchlist_id = ? AND entity_id IN (${placeholders})`,
  ).bind(id, ...ids).run();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE watchlists SET member_count = (SELECT COUNT(*) FROM watchlist_members WHERE watchlist_id = ?),
       last_changed_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(id, now, now, id).run();
  return c.json({ ok: true, removed: r.meta.changes ?? 0 });
});

// "Watch this entity" — single-click. Adds entity to user's default
// watchlist (creating it lazily) and ensures an `any_change` in-app
// rule is attached at the watchlist level on first use.
watchlists.post("/watch/:entityId", async (c) => {
  const email = ownerEmail(c);
  const entityId = c.req.param("entityId");
  let def = await c.env.DB.prepare(
    `SELECT id FROM watchlists WHERE owner_email = ? AND is_default = 1 LIMIT 1`,
  ).bind(email).first<{ id: string }>();
  if (!def) {
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO watchlists (id, owner_email, name, description, is_smart, is_default)
         VALUES (?, ?, 'My Watchlist', 'Default watchlist', 0, 1)`,
    ).bind(id, email).run();
    def = { id };
    // Default any_change in-app rule.
    await c.env.DB.prepare(
      `INSERT INTO alert_rules (id, owner_email, name, watchlist_id, trigger_kind, channel,
                                 digest_frequency, dedupe_window_seconds)
         VALUES (?, ?, 'Any change', ?, 'any_change', 'in_app', 'realtime', 3600)`,
    ).bind(crypto.randomUUID(), email, id).run();
  }
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO watchlist_members (watchlist_id, entity_id, added_at, added_by, source)
       VALUES (?, ?, ?, ?, 'manual')`,
  ).bind(def.id, entityId, now, email).run();
  await c.env.DB.prepare(
    `UPDATE watchlists SET member_count = (SELECT COUNT(*) FROM watchlist_members WHERE watchlist_id = ?),
       last_changed_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(def.id, now, now, def.id).run();
  return c.json({ ok: true, watchlist_id: def.id, added: (r.meta.changes ?? 0) > 0 });
});

watchlists.delete("/watch/:entityId", async (c) => {
  const email = ownerEmail(c);
  const entityId = c.req.param("entityId");
  const def = await c.env.DB.prepare(
    `SELECT id FROM watchlists WHERE owner_email = ? AND is_default = 1 LIMIT 1`,
  ).bind(email).first<{ id: string }>();
  if (!def) return c.json({ ok: true, removed: 0 });
  const r = await c.env.DB.prepare(
    `DELETE FROM watchlist_members WHERE watchlist_id = ? AND entity_id = ?`,
  ).bind(def.id, entityId).run();
  if ((r.meta.changes ?? 0) > 0) {
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE watchlists SET member_count = (SELECT COUNT(*) FROM watchlist_members WHERE watchlist_id = ?),
         last_changed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(def.id, now, now, def.id).run();
  }
  return c.json({ ok: true, removed: r.meta.changes ?? 0 });
});

watchlists.get("/watch/:entityId", async (c) => {
  const email = ownerEmail(c);
  const entityId = c.req.param("entityId");
  const r = await c.env.DB.prepare(
    `SELECT m.watchlist_id, w.name FROM watchlist_members m
       JOIN watchlists w ON w.id = m.watchlist_id
      WHERE w.owner_email = ? AND m.entity_id = ?`,
  ).bind(email, entityId).all<{ watchlist_id: string; name: string }>();
  return c.json({ watching: (r.results ?? []).length > 0, lists: r.results ?? [] });
});

// Force a smart-list re-eval now.
watchlists.post("/:id/reevaluate", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const wl = await c.env.DB.prepare(
    `SELECT id, filter_json, is_smart FROM watchlists WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).first<{ id: string; filter_json: string | null; is_smart: number }>();
  if (!wl) return c.json({ error: "not_found" }, 404);
  if (!wl.is_smart) return c.json({ error: "not_smart" }, 400);
  const r = await reevaluateSmartWatchlist(c.env, id, wl.filter_json);
  return c.json({ ok: true, ...r });
});
