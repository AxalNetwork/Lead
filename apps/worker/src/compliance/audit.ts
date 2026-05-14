// PII access logging. logPiiAccess writes one row per detail-view of a lead
// with the user, the fields read, the operator-supplied reason, IP, UA.

import type { Env } from "../types";

const PII_FIELDS = [
  "email", "phone", "linkedin_url", "twitter_url", "github_url",
  "personal_url", "alt_emails_json",
];

export function piiFieldsPresent(row: Record<string, unknown>): string[] {
  return PII_FIELDS.filter((f) => row[f] != null && row[f] !== "");
}

export async function logPiiAccess(
  env: Env,
  args: { user_email: string; lead_id: string; fields: string[]; reason: string | null; ip: string | null; ua: string | null },
): Promise<void> {
  await env.DB
    .prepare(
      "INSERT INTO pii_access_log (id, user_email, lead_id, fields_json, reason, ip, user_agent, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      args.user_email,
      args.lead_id,
      JSON.stringify(args.fields),
      args.reason,
      args.ip,
      args.ua,
      new Date().toISOString(),
    )
    .run();
}

export async function listPiiAccess(
  db: D1Database,
  args: { from?: string | null; to?: string | null; user?: string | null; lead?: string | null; limit?: number },
): Promise<Array<{ id: string; user_email: string; lead_id: string; fields_json: string; reason: string | null; ip: string | null; user_agent: string | null; accessed_at: string }>> {
  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (args.from) { wheres.push("accessed_at >= ?"); binds.push(args.from); }
  if (args.to) { wheres.push("accessed_at <= ?"); binds.push(args.to); }
  if (args.user) { wheres.push("user_email = ?"); binds.push(args.user); }
  if (args.lead) { wheres.push("lead_id = ?"); binds.push(args.lead); }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = Math.min(Math.max(1, args.limit ?? 200), 1000);
  const r = await db
    .prepare(`SELECT id, user_email, lead_id, fields_json, reason, ip, user_agent, accessed_at FROM pii_access_log ${whereSql} ORDER BY accessed_at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<{ id: string; user_email: string; lead_id: string; fields_json: string; reason: string | null; ip: string | null; user_agent: string | null; accessed_at: string }>();
  return r.results ?? [];
}
