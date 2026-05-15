// Pre-INSERT hook used by the scraper pipeline. Decides whether the incoming
// parsed lead should auto-merge into an existing row, be inserted with
// status='needs_review' (and a dedupe_review row), or inserted as new.

import type { Env } from "../types";
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
import { resolveByVector } from "./vector";
import { withEntityLock } from "../do/EntityLock";

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
  options: { jobId: string; provider: string; dncHit?: boolean },
  cacheEnv?: { SCRAPE_CACHE?: KVNamespace } & Partial<Env>,
): Promise<Decision> {
  const match = await findMatch(db, {
    email: incoming.email,
    phone: incoming.phone,
    linkedin_url: incoming.linkedin_url,
    name: incoming.name,
    org: incoming.org,
    city: incoming.city,
  });

  if (!match) {
    // Task #25 step 3: exact-key miss → vector entity resolution. Only runs
    // when VEC_LEADS binding is configured. Falls through to insert when
    // vectorize/AI is unavailable.
    const env = cacheEnv as Env | undefined;
    if (env?.VEC_LEADS && env?.AI) {
      try {
        const v = await resolveByVector(env, "leads", {
          name: incoming.name,
          org: incoming.org,
          city: incoming.city,
          role: incoming.title,
          bio: incoming.bio,
          email: incoming.email,
        });
        if (v.action === "merge" && v.id) {
          // Look up the candidate row so we can route through the standard
          // mergeIntoExisting path (which writes lead_history, busts caches,
          // etc.). Vector match is the trigger; the merge logic stays the
          // same as exact-key matches above.
          const candidate = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(v.id).first<Lead>();
          if (candidate) {
            const changed = await mergeIntoExisting(db, candidate, incoming, {
              source: `scraper:${options.provider}+vector`,
              evidence_url: incoming.source_url ?? null,
              changed_by: `job:${options.jobId}`,
            }, { dncHit: !!options.dncHit }, cacheEnv);
            if (env?.ENTITY_LOCK) {
              void withEntityLock(env, "lead", candidate.id, "merge_lead", {
                id: candidate.id,
                fields: {
                  name: incoming.name ?? candidate.name,
                  org: incoming.org ?? candidate.org,
                  email: incoming.email ?? candidate.email,
                  title: incoming.title ?? candidate.title,
                  bio: incoming.bio ?? candidate.bio,
                  city: incoming.city ?? candidate.city,
                  source_url: incoming.source_url ?? candidate.source_url,
                },
                history_source: `scraper:${options.provider}+vector`,
              }).catch((e) => console.warn("EntityLock vector-merge sync failed", e.message));
            }
            return { action: "merged", into: candidate.id, changedFields: changed };
          }
        }
        if (v.action === "review" && v.id) {
          const candidate = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(v.id).first<Lead>();
          if (candidate) {
            return { action: "needs_review", candidate, score: v.score ?? REVIEW_THRESHOLD, reasons: v.reasons ?? ["vector"] };
          }
        }
      } catch (e) {
        console.warn("vector dedupe failed", (e as Error).message);
      }
    }
    return { action: "insert" };
  }

  if (match.score >= AUTO_MERGE_THRESHOLD) {
    const env = cacheEnv as Env | undefined;
    const changed = await mergeIntoExisting(db, match.candidate, incoming, {
      source: `scraper:${options.provider}`,
      evidence_url: incoming.source_url ?? null,
      changed_by: `job:${options.jobId}`,
    }, { dncHit: !!options.dncHit }, cacheEnv);
    // Task #25 step 4 + 8: serialize follow-up vector + AI Search index sync
    // through the EntityLock DO. Fire-and-forget — the merge already
    // committed, so a DO failure must not roll back the lead update.
    if (env?.ENTITY_LOCK) {
      void withEntityLock(env, "lead", match.candidate.id, "merge_lead", {
        id: match.candidate.id,
        fields: {
          name: incoming.name ?? match.candidate.name,
          org: incoming.org ?? match.candidate.org,
          email: incoming.email ?? match.candidate.email,
          title: incoming.title ?? match.candidate.title,
          bio: incoming.bio ?? match.candidate.bio,
          city: incoming.city ?? match.candidate.city,
          source_url: incoming.source_url ?? match.candidate.source_url,
        },
        history_source: `scraper:${options.provider}`,
      }).catch((e) => console.warn("EntityLock post-merge sync failed", e.message));
    }
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
