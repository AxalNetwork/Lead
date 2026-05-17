// Digest workflow: pull due rows from digest_queue, group by
// owner_email + watchlist_id, render a single email per group, send.

import type { Env } from "../types";
import { deliverEmail } from "./channels/email";

interface DigestRow {
  id: string;
  owner_email: string;
  watchlist_id: string | null;
  event_id: string;
}

interface EventRow {
  id: string;
  title: string;
  body: string;
  entity_id: string;
  occurred_at: string;
  trigger_kind: string;
}

const MAX_EVENTS_PER_DIGEST = 20;

export async function runDigest(env: Env, opts: { limit?: number } = {}): Promise<{
  groups: number; events: number; sent: number; failed: number;
}> {
  const limit = opts.limit ?? 500;
  const due = await env.DB.prepare(
    `SELECT id, owner_email, watchlist_id, event_id FROM digest_queue
      WHERE status = 'pending' AND datetime(scheduled_for) <= datetime('now')
      ORDER BY scheduled_for ASC LIMIT ?`,
  ).bind(limit).all<DigestRow>();
  const rows = due.results ?? [];
  if (!rows.length) return { groups: 0, events: 0, sent: 0, failed: 0 };

  // Group by owner_email + watchlist_id.
  const groups = new Map<string, { owner_email: string; watchlist_id: string | null; queueIds: string[]; eventIds: string[] }>();
  for (const r of rows) {
    const key = `${r.owner_email}|${r.watchlist_id ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { owner_email: r.owner_email, watchlist_id: r.watchlist_id, queueIds: [], eventIds: [] };
      groups.set(key, g);
    }
    g.queueIds.push(r.id);
    g.eventIds.push(r.event_id);
  }

  let sent = 0, failed = 0, eventsTotal = 0;
  for (const g of groups.values()) {
    const evRows = await loadEvents(env, g.eventIds.slice(0, MAX_EVENTS_PER_DIGEST));
    eventsTotal += evRows.length;
    if (!evRows.length) {
      await markDigestSent(env, g.queueIds, "skipped");
      continue;
    }
    const wlName = g.watchlist_id
      ? (await env.DB.prepare(`SELECT name FROM watchlists WHERE id = ?`).bind(g.watchlist_id).first<{ name: string }>())?.name ?? "Watchlist"
      : "Alerts";
    const html = renderDigestHtml(wlName, evRows);
    const subject = `[AI Data Signal] ${evRows.length} alert${evRows.length > 1 ? "s" : ""} · ${wlName}`;
    const res = await deliverEmail(env, {
      to: [g.owner_email], subject, title: subject,
      bodyHtml: html,
    });
    if (res.ok) { sent++; await markDigestSent(env, g.queueIds, "sent"); }
    else { failed++; await markDigestSent(env, g.queueIds, "failed"); }
  }
  return { groups: groups.size, events: eventsTotal, sent, failed };
}

async function loadEvents(env: Env, ids: string[]): Promise<EventRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const r = await env.DB.prepare(
    `SELECT id, title, body, entity_id, occurred_at, trigger_kind
       FROM alert_events WHERE id IN (${placeholders}) ORDER BY occurred_at DESC`,
  ).bind(...ids).all<EventRow>();
  return r.results ?? [];
}

async function markDigestSent(env: Env, ids: string[], status: "sent" | "failed" | "skipped"): Promise<void> {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE digest_queue SET status = ?, sent_at = ? WHERE id IN (${placeholders})`,
  ).bind(status, now, ...ids).run();
}

function renderDigestHtml(wlName: string, events: EventRow[]): string {
  const rows = events.map((e) => `<tr>
    <td style="padding:8px;border-bottom:1px solid #2a2e36;color:#aab3bf;font-size:12px;">${e.occurred_at}</td>
    <td style="padding:8px;border-bottom:1px solid #2a2e36;">
      <div style="color:#e3e6eb;font-weight:600;">${escapeHtml(e.title)}</div>
      <div style="color:#aab3bf;font-size:13px;margin-top:4px;">${escapeHtml(e.body).replace(/\n/g, "<br>")}</div>
    </td>
  </tr>`).join("");
  return `<h2 style="margin-top:0">${escapeHtml(wlName)} — ${events.length} alert${events.length > 1 ? "s" : ""}</h2>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="margin-top:16px"><a href="https://aidatasignal.com/dashboard/alerts.html" style="color:#5b8def">Open the alerts feed</a></p>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
