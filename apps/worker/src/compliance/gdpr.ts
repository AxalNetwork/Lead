// GDPR right-to-erasure. Given an email (or other identifier), nulls PII on
// every matching lead, sets do_not_contact=1, adds the identifier(s) to the
// DNC list, and writes a single 'gdpr_erasure' row to lead_history per lead.

import type { Env } from "../types";
import { LeadsRepo } from "../db/leads.repo";
import { addDnc, dncFromLead } from "./dnc";
import { normalizeEmail, emailDedupeKey, normalizePhoneE164, canonicalizeLinkedinUrl } from "../scraper/normalize";

const PII_NULLS = {
  email: null,
  phone: null,
  linkedin_url: null,
  twitter_url: null,
  github_url: null,
  personal_url: null,
  alt_emails_json: null,
  bio: null,
};

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

  const rows = await env.DB
    .prepare(`SELECT id, email, phone, linkedin_url FROM leads WHERE ${wheres.join(" OR ")}`)
    .bind(...binds)
    .all<{ id: string; email: string | null; phone: string | null; linkedin_url: string | null }>();

  const repo = new LeadsRepo(env.DB);
  const erased: string[] = [];
  const dncAdded = new Set<string>();
  const reason = "gdpr_erasure";

  // Add the requesting identifiers themselves to DNC up-front.
  if (email) { const r = await addDnc(env.DB, "email", email, reason, actor); if (r.ok && r.value) dncAdded.add(`email:${r.value}`); }
  if (phone) { const r = await addDnc(env.DB, "phone", phone, reason, actor); if (r.ok && r.value) dncAdded.add(`phone:${r.value}`); }
  if (linkedin) { const r = await addDnc(env.DB, "linkedin", linkedin, reason, actor); if (r.ok && r.value) dncAdded.add(`linkedin:${r.value}`); }

  for (const lead of rows.results ?? []) {
    const patch = { ...PII_NULLS, do_not_contact: 1, status: "erased" } as Record<string, unknown>;
    await repo.updateLead(lead.id, patch as Parameters<typeof repo.updateLead>[1], {
      source: "gdpr_erasure",
      evidence_url: `gdpr:${actor}`,
      changed_by: actor,
    });
    // Also write an explicit single audit row so 'change_kind=gdpr_erasure'
    // is queryable directly (the per-field rows above use source='gdpr_erasure').
    await env.DB
      .prepare(
        "INSERT INTO lead_history (id, lead_id, field, old_value, new_value, source, evidence_url, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(), lead.id, "__erasure__", null, "1",
        "gdpr_erasure", `gdpr:${actor}`, actor, new Date().toISOString(),
      )
      .run();
    erased.push(lead.id);
    const added = await dncFromLead(env, lead, reason, actor);
    for (const a of added) dncAdded.add(a);
  }

  return { matched: rows.results?.length ?? 0, erased_lead_ids: erased, dnc_added: [...dncAdded] };
}
