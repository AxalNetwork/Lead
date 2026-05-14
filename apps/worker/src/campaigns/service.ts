// Campaign service: create/list/get; build the member set from the linked
// ICP; export to the requested format; verify HMAC webhooks.

import type { Env } from "../types";
import { matchIcp, type IcpRow } from "../icp/match";
import { renderExport, type ExportFormat, type ExportLead } from "./exporters";

export interface CampaignRow {
  id: string;
  name: string;
  icp_id: string | null;
  channel: string;
  status: string;
  exporter: string | null;
  exported_count: number;
  exported_at: string | null;
  webhook_secret: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function randomSecret(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createCampaign(
  env: Env,
  args: { name: string; icp_id?: string | null; channel?: string; notes?: string | null; created_by: string },
): Promise<CampaignRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const secret = randomSecret();
  await env.DB
    .prepare(
      `INSERT INTO campaigns (id, name, icp_id, channel, status, webhook_secret, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    )
    .bind(id, args.name, args.icp_id ?? null, args.channel ?? "email", secret, args.notes ?? null, args.created_by, now, now)
    .run();
  return (await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>())!;
}

export async function getCampaign(env: Env, id: string): Promise<CampaignRow | null> {
  return await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
}

export async function listCampaigns(env: Env, limit = 100): Promise<CampaignRow[]> {
  const r = await env.DB
    .prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<CampaignRow>();
  return r.results ?? [];
}

async function fetchIcp(env: Env, icpId: string): Promise<IcpRow | null> {
  return await env.DB.prepare("SELECT * FROM icp_profiles WHERE id = ?").bind(icpId).first<IcpRow>();
}

async function loadLeadsForExport(env: Env, leadIds: string[]): Promise<ExportLead[]> {
  if (!leadIds.length) return [];
  const placeholders = leadIds.map(() => "?").join(",");
  const r = await env.DB
    .prepare(
      `SELECT id, name, email, org, title, linkedin_url, twitter_url, city, country_iso2, sector_slug, persona_role
         FROM leads WHERE id IN (${placeholders})`,
    )
    .bind(...leadIds)
    .all<ExportLead>();
  return r.results ?? [];
}

/**
 * Materialize members for a campaign by running the ICP match, upserting
 * `campaign_members` rows, and returning the leads array for export.
 */
export async function materializeCampaign(
  env: Env,
  campaignId: string,
  opts: { limit?: number } = {},
): Promise<{ leads: ExportLead[]; campaign: CampaignRow; matched: number }> {
  const campaign = await getCampaign(env, campaignId);
  if (!campaign) throw new Error("campaign_not_found");
  if (!campaign.icp_id) throw new Error("campaign_has_no_icp");
  const icp = await fetchIcp(env, campaign.icp_id);
  if (!icp) throw new Error("icp_not_found");

  const result = await matchIcp(env.DB, icp, { limit: opts.limit ?? 1000 });
  const leadIds = result.items.map((m) => m.lead_id);

  const now = new Date().toISOString();
  const stmts = leadIds.map((leadId) =>
    env.DB
      .prepare(
        `INSERT INTO campaign_members (id, campaign_id, lead_id, status, added_at)
         VALUES (?, ?, ?, 'queued', ?)
         ON CONFLICT(campaign_id, lead_id) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), campaignId, leadId, now),
  );
  if (stmts.length) await env.DB.batch(stmts);

  const leads = await loadLeadsForExport(env, leadIds);
  return { leads, campaign, matched: result.items.length };
}

export async function exportCampaign(
  env: Env,
  campaignId: string,
  format: ExportFormat,
): Promise<{ body: string; contentType: string; filename: string; count: number }> {
  const { leads, campaign } = await materializeCampaign(env, campaignId);
  const out = renderExport(format, leads);
  const now = new Date().toISOString();
  await env.DB
    .prepare("UPDATE campaigns SET exporter = ?, exported_count = ?, exported_at = ?, status = CASE status WHEN 'draft' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?")
    .bind(format, leads.length, now, now, campaign.id)
    .run();
  return { ...out, count: leads.length };
}

// ---- Webhook verification (HMAC-SHA256) ----

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhookSig(secret: string, body: string, signature: string): Promise<boolean> {
  const expected = await hmacHex(secret, body);
  const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  return timingSafeEq(expected, provided.toLowerCase());
}

export interface WebhookEvent {
  email?: string;
  external_id?: string;
  status: "sent" | "opened" | "clicked" | "replied" | "bounced" | "unsubscribed" | "meeting";
  at?: string;
  meta?: Record<string, unknown>;
}

const ALLOWED_STATUSES = new Set(["sent", "opened", "clicked", "replied", "bounced", "unsubscribed", "meeting"]);

export async function applyWebhookEvent(env: Env, campaignId: string, ev: WebhookEvent): Promise<{ updated: number; reason?: string }> {
  if (!ALLOWED_STATUSES.has(ev.status)) return { updated: 0, reason: "bad_status" };
  // Resolve member by external_id or by lead.email.
  let memberId: string | null = null;
  if (ev.external_id) {
    const r = await env.DB
      .prepare("SELECT id FROM campaign_members WHERE campaign_id = ? AND external_id = ?")
      .bind(campaignId, ev.external_id)
      .first<{ id: string }>();
    if (r) memberId = r.id;
  }
  if (!memberId && ev.email) {
    const lead = await env.DB
      .prepare("SELECT id FROM leads WHERE LOWER(email) = LOWER(?)")
      .bind(ev.email)
      .first<{ id: string }>();
    if (lead) {
      const m = await env.DB
        .prepare("SELECT id FROM campaign_members WHERE campaign_id = ? AND lead_id = ?")
        .bind(campaignId, lead.id)
        .first<{ id: string }>();
      if (m) memberId = m.id;
    }
  }
  if (!memberId) return { updated: 0, reason: "member_not_found" };
  const at = ev.at ?? new Date().toISOString();
  await env.DB
    .prepare(
      "UPDATE campaign_members SET status = ?, last_event_at = ?, external_id = COALESCE(?, external_id), meta_json = ? WHERE id = ?",
    )
    .bind(ev.status, at, ev.external_id ?? null, ev.meta ? JSON.stringify(ev.meta) : null, memberId)
    .run();
  // Mirror replied/meeting onto the lead so it shows in the funnel.
  if (ev.status === "replied" || ev.status === "meeting") {
    const member = await env.DB
      .prepare("SELECT lead_id FROM campaign_members WHERE id = ?")
      .bind(memberId)
      .first<{ lead_id: string }>();
    if (member) {
      await env.DB
        .prepare("UPDATE leads SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('approved','meeting')")
        .bind(ev.status, at, member.lead_id)
        .run();
    }
  }
  return { updated: 1 };
}
