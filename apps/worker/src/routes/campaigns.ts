import { Hono } from "hono";
import type { Env } from "../types";
import {
  createCampaign, listCampaigns, getCampaign, exportCampaign, materializeCampaign,
  applyWebhookEvent, verifyWebhookSig, type WebhookEvent,
} from "../campaigns/service";
import type { ExportFormat } from "../campaigns/exporters";

export const campaigns = new Hono<{ Bindings: Env; Variables: { email: string } }>();

campaigns.get("/", async (c) => {
  const items = await listCampaigns(c.env);
  return c.json({ items });
});

campaigns.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string; icp_id?: string; channel?: string; notes?: string } | null;
  if (!body || !body.name) return c.json({ error: "bad_request", message: "name required" }, 400);
  const created = await createCampaign(c.env, {
    name: body.name,
    icp_id: body.icp_id ?? null,
    channel: body.channel ?? "email",
    notes: body.notes ?? null,
    created_by: c.get("email"),
  });
  return c.json(created, 201);
});

campaigns.get("/:id", async (c) => {
  const row = await getCampaign(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

campaigns.get("/:id/preview", async (c) => {
  try {
    const r = await materializeCampaign(c.env, c.req.param("id"), { limit: 50 });
    return c.json({ campaign: r.campaign, matched: r.matched, sample: r.leads.slice(0, 50) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

campaigns.post("/:id/export", async (c) => {
  const fmt = (c.req.query("format") ?? "csv") as ExportFormat;
  try {
    const out = await exportCampaign(c.env, c.req.param("id"), fmt);
    return new Response(out.body, {
      headers: {
        "Content-Type": out.contentType,
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "X-Lead-Count": String(out.count),
      },
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

campaigns.get("/:id/members", async (c) => {
  const id = c.req.param("id");
  const status = c.req.query("status");
  const wheres = ["cm.campaign_id = ?"];
  const binds: unknown[] = [id];
  if (status) { wheres.push("cm.status = ?"); binds.push(status); }
  const r = await c.env.DB
    .prepare(
      `SELECT cm.id, cm.lead_id, cm.status, cm.external_id, cm.last_event_at, cm.added_at,
              l.name, l.email, l.org
         FROM campaign_members cm
         LEFT JOIN leads l ON l.id = cm.lead_id
        WHERE ${wheres.join(" AND ")}
        ORDER BY cm.added_at DESC LIMIT 1000`,
    )
    .bind(...binds)
    .all();
  return c.json({ items: r.results ?? [] });
});

// Per-lead campaign history (mounted on /api/leads).
export const leadsCampaignActions = new Hono<{ Bindings: Env; Variables: { email: string } }>();
leadsCampaignActions.get("/:id/campaigns", async (c) => {
  const r = await c.env.DB
    .prepare(
      `SELECT cm.id, cm.campaign_id, cm.status, cm.external_id, cm.last_event_at, cm.added_at,
              c.name AS campaign_name, c.channel
         FROM campaign_members cm
         JOIN campaigns c ON c.id = cm.campaign_id
        WHERE cm.lead_id = ?
        ORDER BY cm.added_at DESC LIMIT 200`,
    )
    .bind(c.req.param("id"))
    .all();
  return c.json({ items: r.results ?? [] });
});

// Public webhook (HMAC-signed). Mounted *outside* accessGuard in index.ts so
// marketing tools can post events without a Cloudflare Access cookie.
export const campaignsWebhook = new Hono<{ Bindings: Env }>();
campaignsWebhook.post("/:id/webhook", async (c) => {
  const id = c.req.param("id");
  const sig = c.req.header("X-Signature") || c.req.header("X-Hub-Signature-256") || "";
  if (!sig) return c.json({ error: "missing_signature" }, 401);
  const row = await c.env.DB.prepare("SELECT webhook_secret FROM campaigns WHERE id = ?").bind(id).first<{ webhook_secret: string | null }>();
  if (!row || !row.webhook_secret) return c.json({ error: "not_found" }, 404);
  const raw = await c.req.text();
  const ok = await verifyWebhookSig(row.webhook_secret, raw, sig);
  if (!ok) return c.json({ error: "bad_signature" }, 401);
  let payload: WebhookEvent | WebhookEvent[];
  try { payload = JSON.parse(raw); } catch { return c.json({ error: "bad_json" }, 400); }
  const events = Array.isArray(payload) ? payload : [payload];
  let updated = 0;
  for (const ev of events) {
    const r = await applyWebhookEvent(c.env, id, ev);
    updated += r.updated;
  }
  return c.json({ ok: true, updated });
});
