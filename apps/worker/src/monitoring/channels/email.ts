// Email delivery via MailChannels — free, in-Worker, no API key.
// Docs: https://api.mailchannels.net/tx/v1/documentation

import type { Env } from "../../types";

interface EmailAlertPayload {
  to: string[];
  subject: string;
  title: string;
  bodyHtml: string;
  entityLink?: string;
}

const FROM_EMAIL = "alerts@aidatasignal.com";
const FROM_NAME = "AI Data Signal alerts";

export async function deliverEmail(_env: Env, payload: EmailAlertPayload): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!payload.to.length) return { ok: false, error: "no_recipients" };
  const html = renderEmailHtml(payload);
  const body = {
    personalizations: [{ to: payload.to.map((e) => ({ email: e })) }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: payload.subject,
    content: [{ type: "text/html", value: html }],
  };
  try {
    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `mailchannels:${res.status}:${txt.slice(0, 200)}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: `mailchannels_network:${(e as Error).message}` };
  }
}

function renderEmailHtml(p: EmailAlertPayload): string {
  const link = p.entityLink
    ? `<p><a href="${escapeHtml(p.entityLink)}" style="color:#5b8def">Open in dashboard</a></p>`
    : "";
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#0f1115;color:#e3e6eb;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#1a1d24;border-radius:8px;padding:24px;">
    <h2 style="margin-top:0;color:#e3e6eb;">${escapeHtml(p.title)}</h2>
    <div style="color:#aab3bf;line-height:1.5;">${p.bodyHtml}</div>
    ${link}
    <hr style="border:none;border-top:1px solid #2a2e36;margin:24px 0">
    <div style="color:#6b7280;font-size:12px">AI Data Signal · alert</div>
  </div></body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
