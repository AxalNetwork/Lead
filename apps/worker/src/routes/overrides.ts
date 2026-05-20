// Task #3: Editable Profiles + Manual Overrides with Audit.
//
// Override CRUD, bulk operations, manual entity creation, soft-delete,
// and merge — all gated by the existing accessGuard middleware. Every
// mutation appends an append-only `entity_audit_log` row. Non-admin
// viewers see `<redacted>` for `overridden_by_email` / `actor_email`
// (matches the Task #14 verification-history pattern).
//
// All facts writes still flow through `entities/facts.ts::insertFact`
// (Task #1 canonical write contract). The override layer is a separate
// table that overlays at read time via `getEffectiveFacts` — no direct
// INSERTs into `facts` from any handler in this module.

import { Hono } from "hono";
import type { Env } from "../types";
import { createEntity, addRole } from "../entities/roles";
import type { EntityRole } from "../entities/model";
import { mergeEntities } from "../entities/merge";
import { enqueueSummaryRebuild } from "../entities/summaryQueue";

type Vars = { email: string; is_admin: boolean; request_id: string };

export const overridesRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

interface OverrideValue {
  value_text?: string | null;
  value_numeric?: number | null;
  value_json?: unknown;
}

function pickValue(body: Record<string, unknown>): OverrideValue | { error: string } {
  const hasText = typeof body.value_text === "string" || body.value_text === null;
  const hasNum = typeof body.value_numeric === "number" || body.value_numeric === null;
  const hasJson = body.value_json !== undefined;
  if (!hasText && !hasNum && !hasJson) {
    return { error: "value_required" };
  }
  return {
    value_text: hasText ? (body.value_text as string | null) : null,
    value_numeric: hasNum ? (body.value_numeric as number | null) : null,
    value_json: hasJson ? body.value_json : null,
  };
}

async function writeAuditLog(
  env: Env,
  entityId: string,
  action: string,
  actorEmail: string,
  payload: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO entity_audit_log (id, entity_id, action, actor_email, payload_json) VALUES (?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), entityId, action, actorEmail, JSON.stringify(payload ?? {})).run();
}

function redactEmail(email: string, isAdmin: boolean): string {
  return isAdmin ? email : "<redacted>";
}

// ---------- POST /api/entities/:id/overrides ----------
overridesRoute.post("/entities/:id/overrides", async (c) => {
  const entityId = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const predicate = typeof body.predicate === "string" ? body.predicate.trim() : "";
  if (!predicate) return c.json({ error: "predicate_required" }, 400);
  const reason = typeof body.override_reason === "string" ? body.override_reason.trim() : "";
  if (!reason) return c.json({ error: "override_reason_required" }, 400);
  const val = pickValue(body);
  if ("error" in val) return c.json({ error: val.error }, 400);
  // Verify entity exists and is not deleted/merged.
  const ent = await c.env.DB.prepare(`SELECT id, status FROM u_entities WHERE id = ?`).bind(entityId).first<{ id: string; status: string }>();
  if (!ent) return c.json({ error: "not_found" }, 404);
  if (ent.status === "merged" || ent.status === "soft_deleted") {
    return c.json({ error: "entity_inactive", status: ent.status }, 409);
  }
  const id = crypto.randomUUID();
  const email = c.var.email;
  await c.env.DB.prepare(
    `INSERT INTO field_overrides (
       id, entity_id, predicate, value_text, value_numeric, value_json,
       override_reason, overridden_by_email, locked
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).bind(
    id, entityId, predicate,
    val.value_text ?? null,
    val.value_numeric ?? null,
    val.value_json != null ? JSON.stringify(val.value_json) : null,
    reason, email,
  ).run();
  // Stamp any existing is_current=1 facts for this predicate as
  // superseded so a read that bypasses getEffectiveFacts (legacy callers)
  // still sees the override won. Future inserts are stamped by insertFact.
  await c.env.DB.prepare(
    `UPDATE facts SET superseded_by_override = 1
      WHERE entity_id = ? AND predicate = ? AND is_current = 1`,
  ).bind(entityId, predicate).run();
  await writeAuditLog(c.env, entityId, "field_override", email, {
    override_id: id, predicate, value_text: val.value_text, value_numeric: val.value_numeric, value_json: val.value_json, reason,
  });
  await enqueueSummaryRebuild(c.env, entityId);
  return c.json({ ok: true, override_id: id });
});

// ---------- POST /api/entities/:id/overrides/:override_id/unlock ----------
overridesRoute.post("/entities/:id/overrides/:override_id/unlock", async (c) => {
  const entityId = c.req.param("id");
  const overrideId = c.req.param("override_id");
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { /* optional body */ }
  const reason = typeof body.reason === "string" ? body.reason : null;
  const r = await c.env.DB.prepare(
    `UPDATE field_overrides SET locked = 0, unlock_after = datetime('now')
      WHERE id = ? AND entity_id = ? AND locked = 1`,
  ).bind(overrideId, entityId).run();
  if (!r.meta?.changes) return c.json({ error: "not_found_or_already_unlocked" }, 404);
  // Clear superseded flag on the active fact row(s) so the canonical
  // value reverts to the latest AI/scrape attempt.
  const ov = await c.env.DB.prepare(`SELECT predicate FROM field_overrides WHERE id = ?`).bind(overrideId).first<{ predicate: string }>();
  if (ov?.predicate) {
    await c.env.DB.prepare(
      `UPDATE facts SET superseded_by_override = 0
        WHERE entity_id = ? AND predicate = ? AND is_current = 1`,
    ).bind(entityId, ov.predicate).run();
  }
  await writeAuditLog(c.env, entityId, "field_unlock", c.var.email, { override_id: overrideId, reason });
  await enqueueSummaryRebuild(c.env, entityId);
  return c.json({ ok: true });
});

// ---------- GET /api/entities/:id/overrides/:predicate/history ----------
overridesRoute.get("/entities/:id/overrides/:predicate/history", async (c) => {
  const entityId = c.req.param("id");
  const predicate = c.req.param("predicate");
  const isAdmin = c.var.is_admin === true;
  const [overrides, attempts, auditLog] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, value_text, value_numeric, value_json, override_reason,
              overridden_by_email, overridden_at, locked, unlock_after, bulk_operation_id
         FROM field_overrides
        WHERE entity_id = ? AND predicate = ?
        ORDER BY overridden_at DESC`,
    ).bind(entityId, predicate).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT id, value_text, value_number, value_json, source_kind, source,
              evidence_url, confidence, observed_at, is_current, superseded_by_override
         FROM facts
        WHERE entity_id = ? AND predicate = ?
        ORDER BY observed_at DESC LIMIT 100`,
    ).bind(entityId, predicate).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT id, action, actor_email, payload_json, created_at
         FROM entity_audit_log
        WHERE entity_id = ? AND action IN ('field_override','field_unlock','bulk_override','bulk_revert')
        ORDER BY created_at DESC LIMIT 100`,
    ).bind(entityId).all<Record<string, unknown>>(),
  ]);
  const overrideRows = (overrides.results ?? []).map((r) => ({
    ...r,
    overridden_by_email: redactEmail(String(r.overridden_by_email ?? ""), isAdmin),
  }));
  const auditRows = (auditLog.results ?? []).map((r) => ({
    ...r,
    actor_email: redactEmail(String(r.actor_email ?? ""), isAdmin),
  }));
  return c.json({
    entity_id: entityId,
    predicate,
    overrides: overrideRows,
    attempts: attempts.results ?? [],
    audit_log: auditRows,
  });
});

// ---------- POST /api/entities/overrides/bulk ----------
overridesRoute.post("/entities/overrides/bulk", async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const entityIds = Array.isArray(body.entity_ids) ? body.entity_ids.filter((x) => typeof x === "string") as string[] : [];
  const predicate = typeof body.predicate === "string" ? body.predicate.trim() : "";
  const reason = typeof body.override_reason === "string" ? body.override_reason.trim() : "";
  if (!entityIds.length) return c.json({ error: "entity_ids_required" }, 400);
  if (entityIds.length > 500) return c.json({ error: "too_many_entities", max: 500 }, 400);
  if (!predicate) return c.json({ error: "predicate_required" }, 400);
  if (!reason) return c.json({ error: "override_reason_required" }, 400);
  const val = pickValue(body);
  if ("error" in val) return c.json({ error: val.error }, 400);
  const bulkId = crypto.randomUUID();
  const email = c.var.email;
  const valueText = val.value_text ?? null;
  const valueNumeric = val.value_numeric ?? null;
  const valueJsonStr = val.value_json != null ? JSON.stringify(val.value_json) : null;
  let written = 0;
  for (const entityId of entityIds) {
    try {
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO field_overrides (
           id, entity_id, predicate, value_text, value_numeric, value_json,
           override_reason, overridden_by_email, locked, bulk_operation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).bind(id, entityId, predicate, valueText, valueNumeric, valueJsonStr, reason, email, bulkId).run();
      await c.env.DB.prepare(
        `UPDATE facts SET superseded_by_override = 1
          WHERE entity_id = ? AND predicate = ? AND is_current = 1`,
      ).bind(entityId, predicate).run();
      await writeAuditLog(c.env, entityId, "bulk_override", email, {
        override_id: id, bulk_operation_id: bulkId, predicate, value_text: valueText, value_numeric: valueNumeric, value_json: val.value_json, reason,
      });
      await enqueueSummaryRebuild(c.env, entityId);
      written += 1;
    } catch (e) {
      console.warn("bulk override write failed", entityId, (e as Error).message);
    }
  }
  return c.json({ ok: true, bulk_operation_id: bulkId, written, attempted: entityIds.length });
});

// ---------- POST /api/entities/overrides/bulk/:bulk_operation_id/revert ----------
overridesRoute.post("/entities/overrides/bulk/:bulk_operation_id/revert", async (c) => {
  const bulkId = c.req.param("bulk_operation_id");
  const rows = await c.env.DB.prepare(
    `SELECT id, entity_id, predicate FROM field_overrides WHERE bulk_operation_id = ?`,
  ).bind(bulkId).all<{ id: string; entity_id: string; predicate: string }>();
  const items = rows.results ?? [];
  if (!items.length) return c.json({ error: "bulk_operation_not_found" }, 404);
  await c.env.DB.prepare(
    `UPDATE field_overrides SET locked = 0, unlock_after = datetime('now')
      WHERE bulk_operation_id = ? AND locked = 1`,
  ).bind(bulkId).run();
  const email = c.var.email;
  for (const it of items) {
    await c.env.DB.prepare(
      `UPDATE facts SET superseded_by_override = 0
        WHERE entity_id = ? AND predicate = ? AND is_current = 1`,
    ).bind(it.entity_id, it.predicate).run();
    await writeAuditLog(c.env, it.entity_id, "bulk_revert", email, { bulk_operation_id: bulkId, override_id: it.id, predicate: it.predicate });
    await enqueueSummaryRebuild(c.env, it.entity_id);
  }
  return c.json({ ok: true, bulk_operation_id: bulkId, reverted: items.length });
});

// ---------- POST /api/entities (manual create) ----------
overridesRoute.post("/entities", async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const kind = body.kind === "person" || body.kind === "org" ? body.kind : null;
  const primaryRole = typeof body.primary_role === "string" ? body.primary_role.trim() : null;
  const website = typeof body.website === "string" ? body.website.trim() : null;
  if (!name) return c.json({ error: "name_required" }, 400);
  if (!kind) return c.json({ error: "kind_required" }, 400);
  let domain: string | null = null;
  let url: string | null = null;
  if (website) {
    try {
      const u = new URL(website.startsWith("http") ? website : `https://${website}`);
      url = u.toString();
      domain = u.hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return c.json({ error: "bad_website" }, 400);
    }
  }
  const ent = await createEntity(c.env, {
    kind,
    display_name: name,
    primary_url: url,
    primary_domain: domain,
    // Manual creates suppress the auto-AI-fill so the operator can
    // opt in via ?fill=ai; otherwise a stray "+ Create entity" click
    // could burn neurons. The ?fill=ai branch below opts back in.
    suppressAutoProfileFill: true,
  });
  if (!ent) return c.json({ error: "rejected_by_garbage_guard" }, 400);
  if (primaryRole) {
    await addRole(c.env, ent.id, primaryRole as EntityRole, { is_primary: true, source: "manual_create", confidence: 1 });
  }
  await writeAuditLog(c.env, ent.id, "create", c.var.email, { name, kind, primary_role: primaryRole, website });
  // Optional AI fill (?fill=ai).
  if (c.req.query("fill") === "ai") {
    const wf = (c.env as Env & { WF_PROFILE_FILLER?: { create: (o: { params: Record<string, unknown> }) => Promise<{ id: string }> } }).WF_PROFILE_FILLER;
    if (wf) {
      try { void wf.create({ params: { entityId: ent.id, force: true, triggeredBy: "manual_create" } }).catch(() => undefined); } catch { /* best-effort */ }
    }
  }
  await enqueueSummaryRebuild(c.env, ent.id);
  return c.json({ ok: true, id: ent.id });
});

// ---------- POST /api/entities/:id/soft-delete ----------
overridesRoute.post("/entities/:id/soft-delete", async (c) => {
  const entityId = c.req.param("id");
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { /* optional */ }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return c.json({ error: "reason_required" }, 400);
  const ent = await c.env.DB.prepare(`SELECT id, status FROM u_entities WHERE id = ?`).bind(entityId).first<{ id: string; status: string }>();
  if (!ent) return c.json({ error: "not_found" }, 404);
  if (ent.status === "soft_deleted") return c.json({ error: "already_soft_deleted" }, 409);
  if (ent.status === "merged") return c.json({ error: "entity_merged" }, 409);
  // status='soft_deleted' triggers cascade (mig 208) on entity_roles
  // and clears entity_summary via the queue rebuild below.
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE u_entities SET status = 'soft_deleted', deleted_reason = ?, updated_at = ? WHERE id = ?`,
  ).bind(reason, now, entityId).run();
  await c.env.DB.prepare(`DELETE FROM entity_roles WHERE entity_id = ?`).bind(entityId).run();
  await writeAuditLog(c.env, entityId, "soft_delete", c.var.email, { reason });
  await enqueueSummaryRebuild(c.env, entityId);
  return c.json({ ok: true });
});

// ---------- POST /api/entities/:id/restore ----------
overridesRoute.post("/entities/:id/restore", async (c) => {
  const entityId = c.req.param("id");
  const ent = await c.env.DB.prepare(`SELECT id, status FROM u_entities WHERE id = ?`).bind(entityId).first<{ id: string; status: string }>();
  if (!ent) return c.json({ error: "not_found" }, 404);
  if (ent.status !== "soft_deleted") return c.json({ error: "not_soft_deleted" }, 409);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE u_entities SET status = 'active', deleted_reason = NULL, updated_at = ? WHERE id = ?`,
  ).bind(now, entityId).run();
  await writeAuditLog(c.env, entityId, "restore", c.var.email, {});
  await enqueueSummaryRebuild(c.env, entityId);
  return c.json({ ok: true });
});

// ---------- POST /api/entities/:id/merge-into ----------
// NB: /api/entities/:id/merge already exists on the legacy entitiesRoute
// (Task #4) and uses pickPrimary (quality-score wins). This is a NEW
// operator-driven path that names the target explicitly and writes an
// entity_audit_log row. We mount it at a different sub-path so the
// existing route handler is preserved.
overridesRoute.post("/entities/:id/merge-into", async (c) => {
  const sourceId = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const targetId = typeof body.target_entity_id === "string" ? body.target_entity_id : "";
  if (!targetId) return c.json({ error: "target_entity_id_required" }, 400);
  if (targetId === sourceId) return c.json({ error: "cannot_merge_into_self" }, 400);
  try {
    const result = await mergeEntities(c.env, sourceId, targetId);
    await writeAuditLog(c.env, result.primary_id, "merge", c.var.email, { ...result });
    await writeAuditLog(c.env, result.secondary_id, "merge", c.var.email, { ...result });
    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ error: "merge_failed", message: (e as Error).message }, 400);
  }
});

// ---------- GET /api/entities/:id/audit-log ----------
overridesRoute.get("/entities/:id/audit-log", async (c) => {
  const entityId = c.req.param("id");
  const isAdmin = c.var.is_admin === true;
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? "200")), 500);
  const r = await c.env.DB.prepare(
    `SELECT id, action, actor_email, payload_json, created_at
       FROM entity_audit_log
      WHERE entity_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
  ).bind(entityId, limit).all<{ id: string; action: string; actor_email: string; payload_json: string | null; created_at: string }>();
  const items = (r.results ?? []).map((row) => ({
    ...row,
    actor_email: redactEmail(row.actor_email, isAdmin),
    payload_json: row.payload_json ? (() => { try { return JSON.parse(row.payload_json as string); } catch { return row.payload_json; } })() : null,
  }));
  return c.json({ entity_id: entityId, items });
});

// Nightly unlock_after expiry — wired from scheduled.ts. Flips any
// override whose unlock_after has passed (and still locked=1) to
// locked=0, then clears superseded_by_override on the matching facts
// rows. Bounded per tick.
export async function runOverrideUnlockSweep(env: Env, limit = 500): Promise<{ unlocked: number }> {
  const r = await env.DB.prepare(
    `SELECT id, entity_id, predicate FROM field_overrides
      WHERE locked = 1 AND unlock_after IS NOT NULL AND unlock_after <= datetime('now')
      ORDER BY unlock_after ASC LIMIT ?`,
  ).bind(limit).all<{ id: string; entity_id: string; predicate: string }>();
  const items = r.results ?? [];
  if (!items.length) return { unlocked: 0 };
  for (const it of items) {
    await env.DB.prepare(`UPDATE field_overrides SET locked = 0 WHERE id = ?`).bind(it.id).run();
    await env.DB.prepare(
      `UPDATE facts SET superseded_by_override = 0
        WHERE entity_id = ? AND predicate = ? AND is_current = 1`,
    ).bind(it.entity_id, it.predicate).run();
    await writeAuditLog(env, it.entity_id, "field_unlock", "system:cron", { override_id: it.id, predicate: it.predicate, reason: "unlock_after_expired" });
    await enqueueSummaryRebuild(env, it.entity_id);
  }
  return { unlocked: items.length };
}
