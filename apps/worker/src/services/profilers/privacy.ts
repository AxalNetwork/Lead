// Task #5: Privacy-signal computation.
//
// Returns `{ respects_privacy, reasons }` from declared signals:
//   1. Locked / private socials (X/Twitter "protected", Instagram private,
//      LinkedIn "open profile" off) — when our OSINT layer recorded a
//      locked flag in `identity_handles.evidence_json`.
//   2. "no press", "no media", "do not contact", "private" tokens in the
//      entity's bio / about field as stored in facts (predicate
//      `person.bio` / `person.about` / `person.preference.media`).
//   3. Outstanding takedown / GDPR / right-to-be-forgotten request in our
//      own `pii_audit_log` or `compliance_dnc` for this entity.
//   4. Declared GPC/DNT-style preference: a row in `person_preferences`
//      with key='no_press' or value resembling do-not-track signals.
//
// HARD skip semantics: any single signal flips respects_privacy=true.

import type { Env } from "../../types";
import type { PrivacySignals } from "./types";

const NO_PRESS_TOKENS = [
  "no press", "no media", "do not contact", "do not call",
  "no interviews", "private account", "media-shy", "media shy",
  "request privacy", "right to be forgotten", "decline interviews",
];

export async function computePrivacy(env: Env, entityId: string): Promise<PrivacySignals> {
  const reasons: string[] = [];

  // 1. Locked socials — best-effort: missing OSINT table just means no signal.
  try {
    const r = await env.DB.prepare(
      `SELECT platform, evidence_json
         FROM identity_handles
        WHERE entity_id = ? AND is_active = 1`,
    ).bind(entityId).all<{ platform: string; evidence_json: string | null }>();
    for (const row of (r.results ?? [])) {
      if (!row.evidence_json) continue;
      let ev: Record<string, unknown> = {};
      try { ev = JSON.parse(row.evidence_json) as Record<string, unknown>; } catch { /* ignore */ }
      if (ev.locked === true || ev.protected === true || ev.private === true) {
        reasons.push(`locked_${row.platform}`);
      }
    }
  } catch { /* osint table absent — skip */ }

  // 2. Bio scan via facts (predicate-prefixed search).
  try {
    const r = await env.DB.prepare(
      `SELECT value_text FROM facts
        WHERE entity_id = ?
          AND predicate IN ('person.bio','person.about','person.preference.media','person.identity.bio')
          AND value_text IS NOT NULL
        ORDER BY observed_at DESC LIMIT 5`,
    ).bind(entityId).all<{ value_text: string }>();
    const blob = (r.results ?? []).map((x) => (x.value_text || "").toLowerCase()).join(" \n ");
    for (const tok of NO_PRESS_TOKENS) {
      if (blob.includes(tok)) { reasons.push(`bio_signal:${tok.replace(/\s+/g, "_")}`); break; }
    }
  } catch { /* facts may not exist in lean test setups */ }

  // 3. Outstanding takedown / DNC for this entity.
  //
  // This asked two tables that no migration creates — `pii_audit_log` and
  // `compliance_dnc` — and both reads sat in a bare catch, so the profiler
  // has never once marked anyone do-not-contact. That is not a data-quality
  // gap: it means people who asked not to be contacted were profiled anyway.
  //
  // The real list is `dnc_list` (migrations/070_compliance.sql), keyed by
  // (kind, normalized value) rather than by entity — the same shape
  // compliance/dnc.ts::checkAndScrubDnc uses on the import path. An entity's
  // normalized identifiers live in channels.canonical, so the two join
  // directly. This covers GDPR erasures as well: compliance/gdpr.ts records
  // an erasure by inserting the subject's identifiers into dnc_list, which is
  // what the old `takedown_in_audit` probe was reaching for.
  try {
    const r = await env.DB.prepare(
      `SELECT 1 FROM channels c
         JOIN dnc_list d ON d.kind = c.kind AND d.value = c.canonical
        WHERE c.entity_id = ? LIMIT 1`,
    ).bind(entityId).first<{ "1": number }>();
    if (r) reasons.push("dnc_listed");
  } catch { /* channels/dnc_list absent in a lean test setup */ }
  try {
    // channels carries its own is_dnc flag, set through upsertChannel. Nothing
    // on the DNC write path sets it today, but it is a supported marker and a
    // manually-flagged channel must still count.
    const r = await env.DB.prepare(
      `SELECT 1 FROM channels WHERE entity_id = ? AND is_dnc = 1 LIMIT 1`,
    ).bind(entityId).first<{ "1": number }>();
    if (r && !reasons.includes("dnc_listed")) reasons.push("dnc_listed");
  } catch { /* channels absent in a lean test setup */ }

  // 4. Declared preference rows.
  try {
    const r = await env.DB.prepare(
      `SELECT preference_key, value_text FROM person_preferences
        WHERE entity_id = ?
          AND (preference_key IN ('no_press','no_media','gpc','dnt','do_not_contact')
               OR value_text LIKE '%no_press%' OR value_text LIKE '%do_not_contact%')`,
    ).bind(entityId).all<{ preference_key: string; value_text: string | null }>();
    for (const row of (r.results ?? [])) reasons.push(`preference:${row.preference_key}`);
  } catch { /* person_preferences may not exist in lean test setups */ }

  return { respects_privacy: reasons.length > 0, reasons };
}
