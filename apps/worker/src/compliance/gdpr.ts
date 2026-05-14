// GDPR right-to-erasure. Given an email (or other identifier), nulls PII on
// every matching lead, sets do_not_contact=1, adds the identifier(s) to the
// DNC list, and writes a single change_kind='gdpr_erasure' row to
// lead_history per lead.
//
// All writes for a single erasure request are batched into one D1 transaction
// (db.batch) so we can't end up with partial state on failure.

import type { Env } from "../types";
import { normalizeEmail, emailDedupeKey, normalizePhoneE164, canonicalizeLinkedinUrl } from "../scraper/normalize";
import { normalizeForDnc } from "./dnc";

const PII_NULL_FIELDS = [
  "email", "phone", "linkedin_url", "twitter_url", "github_url",
  "personal_url", "alt_emails_json", "bio",
] as const;

export interface ErasureRequest {
  email?: string;
  phone?: string;
  linkedin_url?: string;
}

export interface ErasureResult {
  matched: number;
  erased_lead_ids: string[];
  dnc_added: string[];
}

export async function eraseByIdentifier(
  env: Env,
  req: ErasureRequest,
  actor: string,
): Promise<ErasureResult> {
  const wheres: string[] = [];
  const binds: unknown[] = [];

  const email = req.email ? normalizeEmail(req.email) : null;
  const emailKey = email ? emailDedupeKey(email) : null;
  const phone = req.phone ? normalizePhoneE164(req.phone) : null;
  const linkedin = req.linkedin_url ? canonicalizeLinkedinUrl(req.linkedin_url) : null;

  if (emailKey) { wheres.push("(canonical_email_key = ? OR LOWER(email) = ?)"); binds.push(emailKey, email!); }
  if (phone) { wheres.push("(canonical_phone_key = ? OR phone = ?)"); binds.push(phone, phone); }
  if (linkedin) { wheres.push("(canonical_linkedin_key = ? OR linkedin_url = ?)"); binds.push(linkedin, linkedin); }

  if (!wheres.length) return { matched: 0, erased_lead_ids: [], dnc_added: [] };

  // Read the matching leads first (read query — not part of the write batch).
  const rows = await env.DB
    .prepare(`SELECT id, email, phone, linkedin_url FROM leads WHERE ${wheres.join(" OR ")}`)
    .bind(...binds)
    .all<{ id: string; email: string | null; phone: string | null; linkedin_url: string | null }>();

  const reason = "gdpr_erasure";
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  const dncSet = new Set<string>();

  // Helper: stage a DNC INSERT (idempotent via INSERT OR IGNORE).
  function stageDnc(kind: "email" | "phone" | "linkedin", rawValue: string | null) {
    if (!rawValue) return;
    const v = normalizeForDnc(kind, rawValue);
    if (!v) return;
    const tag = `${kind}:${v}`;
    if (dncSet.has(tag)) return;
    dncSet.add(tag);
    stmts.push(
      env.DB
        .prepare(
          "INSERT OR IGNORE INTO dnc_list (id, kind, value, reason, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), kind, v, reason, actor, now),
    );
  }

  // DNC for the requesting identifiers themselves.
  if (email) stageDnc("email", email);
  if (phone) stageDnc("phone", phone);
  if (linkedin) stageDnc("linkedin", linkedin);

  const erased: string[] = [];
  for (const lead of rows.results ?? []) {
    const setParts = PII_NULL_FIELDS.map((f) => `${f} = NULL`).join(", ");
    stmts.push(
      env.DB
        .prepare(
          `UPDATE leads SET ${setParts}, do_not_contact = 1, status = 'erased', updated_at = ? WHERE id = ?`,
        )
        .bind(now, lead.id),
    );
    // Single semantic audit row per lead.
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO lead_history
             (id, lead_id, field, old_value, new_value, source, evidence_url, changed_by, changed_at, change_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(), lead.id, "__erasure__", null, "1",
          reason, `gdpr:${actor}`, actor, now, "gdpr_erasure",
        ),
    );
    erased.push(lead.id);
    stageDnc("email", lead.email);
    stageDnc("phone", lead.phone);
    stageDnc("linkedin", lead.linkedin_url);
  }

  // D1's batch() executes all statements as a single, atomic SQL
  // transaction (auto-rollback on any failure) — see Cloudflare D1 docs:
  // https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
  // This satisfies the GDPR "all-or-nothing" requirement for the erasure
  // (PII null + DNC inserts + lead_history change_kind row).
  if (stmts.length) await env.DB.batch(stmts);

  return { matched: rows.results?.length ?? 0, erased_lead_ids: erased, dnc_added: [...dncSet] };
}
