// Pre-INSERT hook used by the scraper pipeline. Decides whether the incoming
// parsed lead should auto-merge into an existing row, be inserted with
// status='needs_review' (and a dedupe_review row), or inserted as new.

import type { Lead } from "../db/leads.types";
import { findMatch, type MatchInput } from "./match";
import { mergeIntoExisting, type IncomingLead } from "./merge";
import {
  canonicalEmailKey,
  canonicalLinkedinKey,
  canonicalNameCityKey,
  canonicalNameFirmKey,
  canonicalPhoneKey,
} from "./keys";

export type Decision =
  | { action: "merged"; into: string; changedFields: number }
  | { action: "needs_review"; candidate: Lead; score: number; reasons: string[] }
  | { action: "insert" };

export const AUTO_MERGE_THRESHOLD = 0.85;
export const REVIEW_THRESHOLD = 0.6;

export function buildCanonicalKeys(input: MatchInput) {
  return {
    canonical_email_key: canonicalEmailKey(input.email),
    canonical_phone_key: canonicalPhoneKey(input.phone),
    canonical_linkedin_key: canonicalLinkedinKey(input.linkedin_url),
    canonical_name_firm_key: canonicalNameFirmKey(input.name, input.org),
    canonical_name_city_key: canonicalNameCityKey(input.name, input.city),
  };
}

export async function resolveIncoming(
  db: D1Database,
  incoming: IncomingLead,
  options: { jobId: string; provider: string },
): Promise<Decision> {
  const match = await findMatch(db, {
    email: incoming.email,
    phone: incoming.phone,
    linkedin_url: incoming.linkedin_url,
    name: incoming.name,
    org: incoming.org,
    city: incoming.city,
  });

  if (!match) return { action: "insert" };

  if (match.score >= AUTO_MERGE_THRESHOLD) {
    const changed = await mergeIntoExisting(db, match.candidate, incoming, {
      source: `scraper:${options.provider}`,
      evidence_url: incoming.source_url ?? null,
      changed_by: `job:${options.jobId}`,
    });
    return { action: "merged", into: match.candidate.id, changedFields: changed };
  }

  if (match.score >= REVIEW_THRESHOLD) {
    return { action: "needs_review", candidate: match.candidate, score: match.score, reasons: match.reasons };
  }

  return { action: "insert" };
}

export async function recordReview(
  db: D1Database,
  primaryLeadId: string,
  candidateLeadId: string,
  score: number,
  reasons: string[],
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO dedupe_review (id, primary_lead_id, candidate_lead_id, score, reasons_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
    )
    .bind(id, primaryLeadId, candidateLeadId, score, JSON.stringify(reasons), new Date().toISOString())
    .run();
  return id;
}
