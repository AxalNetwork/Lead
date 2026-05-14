import { Hono } from "hono";
import type { Env } from "../types";
import { addDnc, listDnc, removeDnc, type DncKind } from "../compliance/dnc";
import { listPiiAccess } from "../compliance/audit";
import { eraseByIdentifier } from "../compliance/gdpr";

export const compliance = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const VALID_KINDS: DncKind[] = ["email", "phone", "domain", "linkedin"];

compliance.get("/dnc", async (c) => {
  const items = await listDnc(c.env.DB, Math.min(Number(c.req.query("limit") ?? "200"), 1000));
  return c.json({ items });
});

compliance.post("/dnc", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { kind?: string; value?: string; reason?: string } | null;
  if (!body || !body.kind || !body.value || !VALID_KINDS.includes(body.kind as DncKind)) {
    return c.json({ error: "bad_request", message: "kind+value required" }, 400);
  }
  const r = await addDnc(c.env.DB, body.kind as DncKind, body.value, body.reason ?? null, c.get("email"));
  if (!r.ok) return c.json({ error: "bad_value" }, 400);
  return c.json(r, r.alreadyExists ? 200 : 201);
});

compliance.delete("/dnc", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { kind?: string; value?: string } | null;
  if (!body || !body.kind || !body.value || !VALID_KINDS.includes(body.kind as DncKind)) {
    return c.json({ error: "bad_request" }, 400);
  }
  const ok = await removeDnc(c.env.DB, body.kind as DncKind, body.value);
  return c.json({ ok });
});

// GET /api/audit/pii?from=&to=&user=&lead=
compliance.get("/audit/pii", async (c) => {
  const items = await listPiiAccess(c.env.DB, {
    from: c.req.query("from") ?? null,
    to: c.req.query("to") ?? null,
    user: c.req.query("user") ?? null,
    lead: c.req.query("lead") ?? null,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : 200,
  });
  return c.json({ items });
});

// POST /api/gdpr/erase  body: { email?, phone?, linkedin_url? }
export const gdpr = new Hono<{ Bindings: Env; Variables: { email: string } }>();
gdpr.post("/erase", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { email?: string; phone?: string; linkedin_url?: string } | null;
  if (!body || (!body.email && !body.phone && !body.linkedin_url)) {
    return c.json({ error: "bad_request", message: "identifier required" }, 400);
  }
  const out = await eraseByIdentifier(c.env, body, c.get("email"));
  return c.json(out);
});

// Per-lead DNC shortcut.
export const leadsDncActions = new Hono<{ Bindings: Env; Variables: { email: string } }>();
leadsDncActions.post("/:id/dnc", async (c) => {
  const id = c.req.param("id");
  const lead = await c.env.DB
    .prepare("SELECT id, email, phone, linkedin_url FROM leads WHERE id = ?")
    .bind(id)
    .first<{ id: string; email: string | null; phone: string | null; linkedin_url: string | null }>();
  if (!lead) return c.json({ error: "not_found" }, 404);
  const reason = "ui:per_lead";
  const added: string[] = [];
  if (lead.email) { const r = await addDnc(c.env.DB, "email", lead.email, reason, c.get("email")); if (r.ok && r.value) added.push(`email:${r.value}`); }
  if (lead.phone) { const r = await addDnc(c.env.DB, "phone", lead.phone, reason, c.get("email")); if (r.ok && r.value) added.push(`phone:${r.value}`); }
  if (lead.linkedin_url) { const r = await addDnc(c.env.DB, "linkedin", lead.linkedin_url, reason, c.get("email")); if (r.ok && r.value) added.push(`linkedin:${r.value}`); }
  await c.env.DB
    .prepare("UPDATE leads SET do_not_contact = 1, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
  return c.json({ ok: true, added });
});
