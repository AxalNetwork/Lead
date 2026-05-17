// Alert rules + events feed + ack/read + test/preview + unread-count.

import { Hono } from "hono";
import type { Env } from "../types";
import { ALL_TRIGGER_KINDS, type TriggerKind } from "../monitoring/types";
import { monitorEntity } from "../monitoring/dispatch";

export const alerts = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function ownerEmail(c: { get: (k: string) => string }) { return c.get("email"); }

// ---- Rules CRUD ----

alerts.get("/rules", async (c) => {
  const email = ownerEmail(c);
  const r = await c.env.DB.prepare(
    `SELECT id, name, watchlist_id, entity_id, trigger_kind, trigger_config_json,
            channel, channel_config_json, digest_frequency, dedupe_window_seconds,
            is_active, last_fired_at, fire_count, created_at, updated_at
       FROM alert_rules WHERE owner_email = ? ORDER BY created_at DESC`,
  ).bind(email).all();
  return c.json({ items: r.results ?? [] });
});

alerts.post("/rules", async (c) => {
  const email = ownerEmail(c);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.trigger_kind !== "string") {
    return c.json({ error: "bad_request", message: "trigger_kind required" }, 400);
  }
  if (!ALL_TRIGGER_KINDS.includes(body.trigger_kind as TriggerKind)) {
    return c.json({ error: "bad_trigger_kind", allowed: ALL_TRIGGER_KINDS }, 400);
  }
  if (!body.watchlist_id && !body.entity_id) {
    return c.json({ error: "bad_request", message: "watchlist_id or entity_id required" }, 400);
  }
  // Cross-tenant guard: if watchlist_id is provided, verify caller owns it.
  if (body.watchlist_id) {
    const owned = await c.env.DB.prepare(
      `SELECT id FROM watchlists WHERE id = ? AND owner_email = ?`,
    ).bind(body.watchlist_id, email).first<{ id: string }>();
    if (!owned) return c.json({ error: "forbidden", message: "watchlist not owned" }, 403);
  }
  const channel = String(body.channel ?? "in_app");
  if (!["in_app", "email", "slack", "webhook", "digest"].includes(channel)) {
    return c.json({ error: "bad_channel" }, 400);
  }
  let channelCfg: Record<string, unknown> = (typeof body.channel_config === "object" && body.channel_config) ? body.channel_config as Record<string, unknown> : {};
  // Webhook: auto-generate secret if absent.
  if (channel === "webhook" && !channelCfg.webhook_secret) {
    channelCfg.webhook_secret = generateSecret();
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO alert_rules (id, owner_email, name, watchlist_id, entity_id, trigger_kind,
       trigger_config_json, channel, channel_config_json, digest_frequency, dedupe_window_seconds, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, email, String(body.name ?? `${body.trigger_kind} rule`),
    body.watchlist_id ?? null, body.entity_id ?? null, body.trigger_kind,
    body.trigger_config ? JSON.stringify(body.trigger_config) : null,
    channel, JSON.stringify(channelCfg),
    String(body.digest_frequency ?? "daily"),
    Number(body.dedupe_window_seconds ?? 3600),
    body.is_active === false ? 0 : 1,
  ).run();
  // Return webhook_secret exactly once (UI needs to display it).
  return c.json({ id, ok: true, webhook_secret: channel === "webhook" ? channelCfg.webhook_secret : undefined }, 201);
});

alerts.patch("/rules/:id", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  const fields: string[] = [];
  const binds: unknown[] = [];
  for (const k of ["name", "digest_frequency"]) {
    if (k in body) { fields.push(`${k} = ?`); binds.push(body[k] ?? null); }
  }
  if ("is_active" in body) { fields.push("is_active = ?"); binds.push(body.is_active ? 1 : 0); }
  if ("dedupe_window_seconds" in body) { fields.push("dedupe_window_seconds = ?"); binds.push(Number(body.dedupe_window_seconds) || 3600); }
  if ("trigger_config" in body) { fields.push("trigger_config_json = ?"); binds.push(body.trigger_config ? JSON.stringify(body.trigger_config) : null); }
  if ("channel_config" in body) { fields.push("channel_config_json = ?"); binds.push(body.channel_config ? JSON.stringify(body.channel_config) : null); }
  if (!fields.length) return c.json({ error: "no_changes" }, 400);
  fields.push("updated_at = datetime('now')");
  const r = await c.env.DB.prepare(
    `UPDATE alert_rules SET ${fields.join(", ")} WHERE id = ? AND owner_email = ?`,
  ).bind(...binds, id, email).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

alerts.delete("/rules/:id", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const r = await c.env.DB.prepare(
    `DELETE FROM alert_rules WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

// ---- Events feed ----

alerts.get("/events", async (c) => {
  const email = ownerEmail(c);
  const status = c.req.query("status");
  const entityId = c.req.query("entity_id");
  const kind = c.req.query("kind");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const format = c.req.query("format");
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 1000);

  const wheres = ["owner_email = ?"];
  const binds: unknown[] = [email];
  if (status) { wheres.push("delivery_status = ?"); binds.push(status); }
  if (entityId) { wheres.push("entity_id = ?"); binds.push(entityId); }
  if (kind) { wheres.push("trigger_kind = ?"); binds.push(kind); }
  if (from) { wheres.push("occurred_at >= ?"); binds.push(from); }
  if (to) { wheres.push("occurred_at <= ?"); binds.push(to); }

  const sql = `SELECT id, rule_id, watchlist_id, entity_id, trigger_kind, title, body,
                       diff_json, channel, delivery_status, occurred_at, delivered_at,
                       read_at, acked_at
                  FROM alert_events WHERE ${wheres.join(" AND ")}
                  ORDER BY occurred_at DESC LIMIT ?`;
  const r = await c.env.DB.prepare(sql).bind(...binds, limit).all<Record<string, unknown>>();
  const items = r.results ?? [];

  if (format === "csv") {
    const headers = ["occurred_at", "trigger_kind", "title", "entity_id", "channel", "delivery_status"];
    const rows = items.map((it) => headers.map((h) => csvEscape(String((it as Record<string, unknown>)[h] ?? ""))).join(","));
    return new Response([headers.join(","), ...rows].join("\n"), {
      headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=alerts.csv" },
    });
  }
  return c.json({ items });
});

alerts.post("/events/:id/ack", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE alert_events SET acked_at = ?, acked_by = ?, read_at = COALESCE(read_at, ?)
       WHERE id = ? AND owner_email = ?`,
  ).bind(now, email, now, id, email).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

alerts.post("/events/ack-bulk", async (c) => {
  const email = ownerEmail(c);
  const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((x) => typeof x === "string") as string[] : [];
  if (!ids.length) return c.json({ ok: true, changed: 0 });
  const placeholders = ids.map(() => "?").join(",");
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE alert_events SET acked_at = ?, acked_by = ?, read_at = COALESCE(read_at, ?)
       WHERE owner_email = ? AND id IN (${placeholders})`,
  ).bind(now, email, now, email, ...ids).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

alerts.post("/events/:id/read", async (c) => {
  const email = ownerEmail(c);
  const id = c.req.param("id");
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE alert_events SET read_at = ? WHERE id = ? AND owner_email = ? AND read_at IS NULL`,
  ).bind(now, id, email).run();
  return c.json({ ok: true });
});

alerts.post("/events/read-all", async (c) => {
  const email = ownerEmail(c);
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE alert_events SET read_at = ? WHERE owner_email = ? AND read_at IS NULL`,
  ).bind(now, email).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

alerts.get("/unread-count", async (c) => {
  const email = ownerEmail(c);
  const r = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM alert_events WHERE owner_email = ? AND read_at IS NULL
        AND delivery_status NOT IN ('suppressed_duplicate','digested')`,
  ).bind(email).first<{ n: number }>();
  return c.json({ unread: r?.n ?? 0 });
});

// Manual test/preview — runs the entity through monitorEntity once.
// Useful for the rule editor "preview" button.
alerts.post("/test/:rule_id", async (c) => {
  const email = ownerEmail(c);
  const ruleId = c.req.param("rule_id");
  const rule = await c.env.DB.prepare(
    `SELECT id, entity_id, watchlist_id FROM alert_rules WHERE id = ? AND owner_email = ?`,
  ).bind(ruleId, email).first<{ id: string; entity_id: string | null; watchlist_id: string | null }>();
  if (!rule) return c.json({ error: "not_found" }, 404);
  const entityId = rule.entity_id ?? (await c.env.DB
    .prepare(`SELECT entity_id FROM watchlist_members WHERE watchlist_id = ? LIMIT 1`)
    .bind(rule.watchlist_id ?? "").first<{ entity_id: string }>())?.entity_id;
  if (!entityId) return c.json({ error: "no_entity_to_test" }, 400);
  // Force a fresh evaluation by deleting the latest snapshot for this entity.
  await c.env.DB.prepare(
    `DELETE FROM entity_snapshots WHERE id = (
        SELECT id FROM entity_snapshots WHERE entity_id = ? ORDER BY snapshot_at DESC LIMIT 1
     )`,
  ).bind(entityId).run();
  const r = await monitorEntity(c.env, entityId);
  return c.json({ ok: true, entity_id: entityId, result: r });
});

alerts.get("/trigger-kinds", async (c) => c.json({ kinds: ALL_TRIGGER_KINDS }));

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
