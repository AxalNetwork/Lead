// Task #8: per-entity persona-match refresh trigger.
//
// Called from entity write paths (insertFact, addCareerEntry) so a new
// job or relocation flows into persona candidate rankings within
// minutes, not at the next nightly cron. Debounced via KV so a burst
// of fact writes for the same entity only triggers one re-match.

import type { Env } from "../types";

// Predicates that materially affect a person-entity's persona score.
// Other predicates (donations, family ties, lifestyle, etc.) are
// ignored here so we don't dispatch on unrelated edits.
const RELEVANT_PREDICATES = new Set<string>([
  "person.career", "person.title", "title",
  "person.seniority", "person.department",
  "person.location.country", "person.location.city",
  "location.country", "location.city",
  "employer", "person.employer",
  // `employees` is the spelling that actually gets written; without it a
  // fresh headcount fact never re-scored the entity it belongs to.
  "employees",
  "org.headcount", "org.employees",
  "company.employees", "company.headcount",
  "org.sector", "sector",
  "org.stage", "stage",
]);

export function isRelevantPredicate(predicate: string | null | undefined): boolean {
  if (!predicate) return false;
  return RELEVANT_PREDICATES.has(predicate);
}

const DEBOUNCE_SECONDS = 300; // 5 minutes

export async function triggerEntityMatchRefresh(env: Env, entityId: string): Promise<void> {
  if (!entityId) return;
  // KV debounce — first write wins per 5min window.
  try {
    const kvKey = `pem:trigger:${entityId}`;
    if (env.SESSIONS) {
      const existing = await env.SESSIONS.get(kvKey);
      if (existing) return;
      await env.SESSIONS.put(kvKey, "1", { expirationTtl: DEBOUNCE_SECONDS });
    }
  } catch (e) {
    console.warn("triggerEntityMatchRefresh debounce check failed", entityId, (e as Error).message);
    // Fall through — better to dispatch than miss the trigger.
  }
  // Dispatch the per-entity workflow; inline fallback runs the service.
  try {
    if (env.WF_PERSONA_MATCH_ENTITY) {
      await env.WF_PERSONA_MATCH_ENTITY.create({ params: { entityId } });
      return;
    }
    const { scoreEntityAcrossPersonas } = await import("./personaMatching.js");
    await scoreEntityAcrossPersonas(env, entityId);
  } catch (e) {
    console.warn("triggerEntityMatchRefresh dispatch failed", entityId, (e as Error).message);
  }
}
