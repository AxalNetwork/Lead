// Slack delivery via incoming-webhook URL. Renders a Block Kit message
// with an entity-card section + diff section.

import type { Env } from "../../types";
import type { FieldDiff } from "../diff";

interface SlackPayload {
  webhookUrl: string;
  title: string;
  entityName: string;
  entityUrl?: string;
  diff: FieldDiff[];
  body: string;
}

export async function deliverSlack(_env: Env, p: SlackPayload): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!/^https:\/\/hooks\.slack\.com\//.test(p.webhookUrl)) {
    return { ok: false, error: "bad_slack_url" };
  }
  const blocks = buildBlocks(p);
  try {
    const res = await fetch(p.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: p.title, blocks }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `slack:${res.status}:${txt.slice(0, 200)}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: `slack_network:${(e as Error).message}` };
  }
}

function buildBlocks(p: SlackPayload): unknown[] {
  const diffLines = p.diff.slice(0, 8).map((d) => `• *${d.field}*: \`${fmt(d.old)}\` → \`${fmt(d.new)}\``);
  if (p.diff.length > 8) diffLines.push(`_…and ${p.diff.length - 8} more_`);

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: p.title.slice(0, 150), emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: p.entityUrl
          ? `*Entity:* <${p.entityUrl}|${escapeMd(p.entityName)}>`
          : `*Entity:* ${escapeMd(p.entityName)}`,
      },
    },
  ];
  if (p.body) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: p.body.slice(0, 2900) } });
  }
  if (diffLines.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: diffLines.join("\n") } });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `AI Data Signal · ${new Date().toISOString()}` }],
  });
  return blocks;
}

function escapeMd(s: string): string {
  return String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (Array.isArray(v)) return v.length ? `[${v.slice(0, 3).join(",")}${v.length > 3 ? "…" : ""}]` : "[]";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
