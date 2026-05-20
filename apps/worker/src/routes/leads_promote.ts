// Task #2 (Leads unification): bulk promote endpoint.
//
// POST /api/leads/promote
//   body: { ids: string[], role: "investor"|"customer"|"prospect"|"founder"|"operator", drop_lead?: boolean }
//   - Resolves each legacy leads.id → u_entities.id via entity_legacy_map.
//   - Calls addRole(entityId, role) (canonical Task #1 write helper) for
//     each. Idempotent: existing (entity_id, role) rows are ON CONFLICT
//     no-ops at the SQL layer.
//   - When drop_lead=true (default), deletes the entity_roles row with
//     role='lead' so the entity drops off the Leads list.
//   - Unknown role → 400. Missing/empty ids → 400.
//   - Mounted under /api/leads in src/index.ts (so accessGuard applies).

import { Hono } from "hono";
import type { Env } from "../types";
import { addRole, getLegacyEntityId } from "../entities/roles";

export const leadsPromote = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const PROMOTE_TARGETS = new Set(["investor", "customer", "prospect", "founder", "operator"]);

leadsPromote.post("/promote", async (c) => {
  let body: { ids?: unknown; role?: unknown; drop_lead?: unknown } = {};
  try { body = await c.req.json(); } catch { /* fall through to validation */ }
  const role = typeof body.role === "string" ? body.role.toLowerCase().trim() : "";
  if (!PROMOTE_TARGETS.has(role)) {
    return c.json({ error: "bad_role", message: `role must be one of: ${[...PROMOTE_TARGETS].join(", ")}` }, 400);
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  if (ids.length === 0) return c.json({ error: "no_ids" }, 400);
  if (ids.length > 500) return c.json({ error: "too_many", message: "max 500 ids per call" }, 400);
  const dropLead = body.drop_lead === false ? false : true;

  let promoted = 0;
  let unresolved = 0;
  const email = c.var.email ?? "ui";
  for (const leadId of ids) {
    const entityId = await getLegacyEntityId(c.env, "leads", leadId);
    if (!entityId) { unresolved++; continue; }
    await addRole(c.env, entityId, role as never, {
      source: `ui:promote:${email}`,
      confidence: 1,
    });
    if (dropLead) {
      try {
        await c.env.DB.prepare(
          `DELETE FROM entity_roles WHERE entity_id = ? AND role = 'lead'`,
        ).bind(entityId).run();
      } catch (e) {
        console.warn("leads.promote drop_lead failed", entityId, (e as Error).message);
      }
    }
    promoted++;
  }
  console.log("leads.promote", JSON.stringify({ role, promoted, unresolved, drop_lead: dropLead, by: email }));
  return c.json({ ok: true, promoted, unresolved, role });
});
