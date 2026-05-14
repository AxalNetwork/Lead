// Do-not-contact list. Pre-insert hook scrubs DNC-listed PII before a lead
// is persisted (keeps the row but blanks email/phone/socials and flips
// do_not_contact=1). Also exposes lookup + admin add/remove.

import type { Env } from "../types";
import { normalizeEmail, normalizePhoneE164, canonicalizeLinkedinUrl, extractDomain } from "../scraper/normalize";

export type DncKind = "email" | "phone" | "domain" | "linkedin";

export interface DncRow {
  id: string;
  kind: DncKind;
  value: string;
  reason: string | null;
  added_by: string | null;
  added_at: string;
}

export function normalizeForDnc(kind: DncKind, raw: string): string | null {
  switch (kind) {
    case "email": return normalizeEmail(raw);
    case "phone": return normalizePhoneE164(raw);
    case "linkedin": return canonicalizeLinkedinUrl(raw);
    case "domain": {
      const d = extractDomain(raw.includes("://") ? raw : `https://${raw}`) || raw.toLowerCase();
      return d || null;
    }
  }
}

export async function addDnc(
  db: D1Database,
  kind: DncKind,
  rawValue: string,
  reason: string | null,
  addedBy: string | null,
): Promise<{ ok: boolean; value: string | null; alreadyExists: boolean }> {
  const value = normalizeForDnc(kind, rawValue);
  if (!value) return { ok: false, value: null, alreadyExists: false };
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        "INSERT INTO dnc_list (id, kind, value, reason, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), kind, value, reason, addedBy, now)
      .run();
    return { ok: true, value, alreadyExists: false };
  } catch (e) {
    // Unique violation = already on the list.
    if ((e as Error).message.includes("UNIQUE")) return { ok: true, value, alreadyExists: true };
    throw e;
  }
}

export async function removeDnc(db: D1Database, kind: DncKind, rawValue: string): Promise<boolean> {
  const value = normalizeForDnc(kind, rawValue);
  if (!value) return false;
  const r = await db.prepare("DELETE FROM dnc_list WHERE kind = ? AND value = ?").bind(kind, value).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function listDnc(db: D1Database, limit = 200): Promise<DncRow[]> {
  const r = await db
    .prepare("SELECT id, kind, value, reason, added_by, added_at FROM dnc_list ORDER BY added_at DESC LIMIT ?")
    .bind(limit)
    .all<DncRow>();
  return r.results ?? [];
}

export interface IncomingPii {
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  github_url: string | null;
  source_domain: string | null;
}

export interface DncCheckResult {
  hit: boolean;
  reasons: string[];
  cleaned: IncomingPii;
}

/**
 * Pre-insert hook: returns the same shape with DNC-listed PII scrubbed and a
 * `hit` flag indicating do_not_contact should be set on the lead row.
 */
export async function checkAndScrubDnc(env: Env, incoming: IncomingPii): Promise<DncCheckResult> {
  const reasons: string[] = [];
  const cleaned: IncomingPii = { ...incoming };

  const checks: Array<{ kind: DncKind; raw: string | null; clear: () => void }> = [
    { kind: "email", raw: incoming.email, clear: () => { cleaned.email = null; } },
    { kind: "phone", raw: incoming.phone, clear: () => { cleaned.phone = null; } },
    { kind: "linkedin", raw: incoming.linkedin_url, clear: () => { cleaned.linkedin_url = null; } },
    { kind: "domain", raw: incoming.source_domain, clear: () => { /* never scrub source_domain itself */ } },
  ];

  for (const ch of checks) {
    if (!ch.raw) continue;
    const norm = normalizeForDnc(ch.kind, ch.raw);
    if (!norm) continue;
    const hit = await env.DB
      .prepare("SELECT 1 FROM dnc_list WHERE kind = ? AND value = ? LIMIT 1")
      .bind(ch.kind, norm)
      .first<{ 1: number }>();
    if (hit) {
      reasons.push(`${ch.kind}:${norm}`);
      ch.clear();
    }
  }

  // Domain blocks scrub *all* PII for that source.
  if (reasons.some((r) => r.startsWith("domain:"))) {
    cleaned.email = null;
    cleaned.phone = null;
    cleaned.linkedin_url = null;
    cleaned.twitter_url = null;
    cleaned.github_url = null;
  }

  return { hit: reasons.length > 0, reasons, cleaned };
}

/** Used by GDPR erasure: mark a lead do_not_contact and add its PII to the list. */
export async function dncFromLead(
  env: Env,
  lead: { id: string; email: string | null; phone?: string | null; linkedin_url?: string | null },
  reason: string,
  addedBy: string,
): Promise<string[]> {
  const added: string[] = [];
  const tries: Array<{ kind: DncKind; raw: string | null | undefined }> = [
    { kind: "email", raw: lead.email },
    { kind: "phone", raw: lead.phone ?? null },
    { kind: "linkedin", raw: lead.linkedin_url ?? null },
  ];
  for (const t of tries) {
    if (!t.raw) continue;
    const r = await addDnc(env.DB, t.kind, t.raw, reason, addedBy);
    if (r.ok && r.value) added.push(`${t.kind}:${r.value}`);
  }
  return added;
}
