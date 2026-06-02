// Task #5: denormalized dossier reader.
//
// Reads from every Task #4 structured table + the latest
// person_dossier_synthesis row. KV-cached for 10 minutes keyed by
// (entity_id, latest_synth_id). Private family_ties are NEVER included
// in this read — the route layer must use a separate operator-only
// endpoint if it wants to surface them.

import type { Env } from "../../types";

interface Row { [k: string]: unknown }

async function rows<T = Row>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).all<T>();
    return r.results ?? [];
  } catch { return []; }
}

export interface DossierBundle {
  entity_id: string;
  identity: Row | null;
  /**
   * Task #7: active identity handles (is_active=1) discovered by the
   * OSINT layer + promoted from scraped social URLs. The header
   * quick-actions + Contact & links block read this.
   */
  identity_handles: Row[];
  /**
   * Task #7: social/web links derived from contact facts (bare canonical
   * `linkedin_url` / `twitter_url` / `github_url` / `website` predicates
   * AND the role-prefixed `founder.linkedin_url` variants the AI mapper
   * writes). De-duped by platform; verified rows win.
   */
  social_links: Array<{ platform: string; url: string; verified: boolean; confidence: number; source_url: string | null }>;
  career_history: Row[];
  board_seats: Row[];
  education_history: Row[];
  family_ties_public: Row[];     // public-only — private rows are operator-route-only
  preferences: Row[];
  interests: Row[];
  lifestyle_signals: Row[];
  travel_patterns: Row[];
  conference_attendance: Row[];
  goals: Row[];
  conversation_hooks: Row[];
  appreciation_signals: Row[];
  latest_synthesis: {
    id: string; computed_at: string; to_do_business_with_them: unknown;
    conversation_starters_count: number; warm_intro_paths_count: number;
    citations_count: number; llm_model: string | null;
  } | null;
  populated_tables: string[];
  /**
   * Enrichers that the most-recent run did NOT execute because the
   * privacy gate fired. The UI renders these as "skipped for privacy"
   * badges so users can SEE that we deliberately did not collect a
   * particular signal class, rather than silently omitting it.
   */
  privacy_skipped_enrichers: Array<{ enricher_name: string; category: string; reason: string }>;
  cached_at: string;
  cache_key: string;
}

export interface ReadOptions {
  /** Bypass KV cache (operator/debug flag). */
  noCache?: boolean;
  /**
   * Viewer entity id, included in the cache key so viewer-specific
   * warm-intro paths (computed by routes/profilers.ts at read time)
   * never bleed across callers via a shared cache entry.
   */
  viewerEntityId?: string | null;
}

const CACHE_TTL_SECONDS = 600; // 10 minutes per spec

function kvKey(entityId: string, synthId: string | null, viewerEntityId: string | null): string {
  return `dossier:v1:${entityId}:${synthId ?? "none"}:${viewerEntityId ?? "noview"}`;
}

export async function readDossier(
  env: Env, entityId: string, opts: ReadOptions = {},
): Promise<DossierBundle> {
  // Look up the latest synth id first so the cache key is correct.
  const synthRow = await rows<{ id: string; computed_at: string; to_do_business_with_them_json: string;
    conversation_starters_count: number; warm_intro_paths_count: number; citations_count: number; llm_model: string | null }>(
    env,
    `SELECT id, computed_at, to_do_business_with_them_json,
            conversation_starters_count, warm_intro_paths_count,
            citations_count, llm_model
       FROM person_dossier_synthesis
      WHERE entity_id = ?
      ORDER BY computed_at DESC LIMIT 1`,
    entityId,
  );
  const latestSynthId = synthRow[0]?.id ?? null;
  const key = kvKey(entityId, latestSynthId, opts.viewerEntityId ?? null);

  if (!opts.noCache) {
    try {
      const cached = await env.SESSIONS.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as DossierBundle;
        return parsed;
      }
    } catch { /* cache miss is fine */ }
  }

  const [
    identityRows, career, boards, education, familyPublic, preferences,
    interests, lifestyle, travel, conferences, goals, hooks, appreciation,
    handleRows, contactFactRows,
  ] = await Promise.all([
    rows(env, `SELECT * FROM person_identity WHERE entity_id = ?`, entityId),
    rows(env, `SELECT * FROM career_history WHERE entity_id = ? ORDER BY is_current DESC, started_at DESC`, entityId),
    rows(env, `SELECT * FROM board_seats WHERE entity_id = ? ORDER BY started_at DESC`, entityId),
    rows(env, `SELECT * FROM education_history WHERE entity_id = ? ORDER BY ended_year DESC`, entityId),
    rows(env, `SELECT * FROM family_ties WHERE entity_id = ? AND is_public = 1 ORDER BY observed_at DESC`, entityId),
    rows(env, `SELECT * FROM person_preferences WHERE entity_id = ? ORDER BY observed_at DESC`, entityId),
    rows(env, `SELECT * FROM person_interests WHERE entity_id = ? ORDER BY weight DESC, observed_at DESC`, entityId),
    rows(env, `SELECT * FROM lifestyle_signals WHERE entity_id = ? ORDER BY observed_at DESC`, entityId),
    rows(env, `SELECT * FROM travel_patterns WHERE entity_id = ? ORDER BY observed_at DESC`, entityId),
    rows(env, `SELECT * FROM conference_attendance WHERE entity_id = ? ORDER BY year DESC`, entityId),
    // Task #4 schema names the goals table `person_goals` (matches addGoal helper).
    rows(env, `SELECT * FROM person_goals WHERE entity_id = ? ORDER BY observed_at DESC`, entityId),
    rows(env, `SELECT * FROM conversation_hooks WHERE entity_id = ? ORDER BY observed_at DESC`, entityId),
    rows(env, `SELECT * FROM appreciation_signals WHERE entity_id = ? ORDER BY observed_at DESC`, entityId),
    // Task #7: active identity handles + contact/social facts.
    rows(env,
      `SELECT id, platform, handle, url, link_method, link_confidence, last_verified_at
         FROM identity_handles
        WHERE entity_id = ? AND is_active = 1
        ORDER BY link_confidence DESC, last_verified_at DESC`,
      entityId),
    rows<{ predicate: string; value_text: string; verified: number; confidence: number; evidence_url: string | null }>(env,
      `SELECT predicate, value_text, verified, confidence, evidence_url
         FROM facts
        WHERE entity_id = ? AND is_current = 1 AND value_text IS NOT NULL
          AND ( predicate = 'email'
             OR predicate LIKE '%email'
             OR predicate LIKE '%linkedin_url'
             OR predicate LIKE '%twitter_url'
             OR predicate LIKE '%github_url'
             OR predicate LIKE '%personal_url'
             OR predicate LIKE '%website' )
        ORDER BY verified DESC, confidence DESC`,
      entityId),
  ]);

  // Task #7: derive a primary email + de-duped social links from the
  // contact facts. The query already orders verified-then-confident first,
  // so the first row per platform / the first email is the strongest.
  const platformOf = (predicate: string): string | null => {
    if (predicate.endsWith("linkedin_url")) return "linkedin";
    if (predicate.endsWith("twitter_url")) return "twitter";
    if (predicate.endsWith("github_url")) return "github";
    if (predicate.endsWith("personal_url") || predicate.endsWith("website")) return "website";
    return null;
  };
  const emailFact = contactFactRows.find((f) => f.predicate === "email" || f.predicate.endsWith("email"));
  const primaryEmail = emailFact?.value_text ?? null;
  const social_links: DossierBundle["social_links"] = [];
  const socialSeen = new Set<string>();
  for (const f of contactFactRows) {
    const platform = platformOf(f.predicate);
    if (!platform || socialSeen.has(platform)) continue;
    socialSeen.add(platform);
    social_links.push({
      platform, url: f.value_text,
      verified: !!f.verified, confidence: f.confidence,
      source_url: f.evidence_url ?? null,
    });
  }
  // Attach the email onto the identity object (the header + Contact block
  // read `identity.primary_email`). Create a minimal identity object when
  // there's no person_identity row but we DO have an email fact, so the
  // contact still surfaces.
  let identity: Row | null = identityRows[0] ?? null;
  if (primaryEmail) {
    identity = { ...(identity ?? {}) };
    if (identity.primary_email == null) identity.primary_email = primaryEmail;
    if (identity.email == null) identity.email = primaryEmail;
  }

  const populated: string[] = [];
  if (identityRows.length) populated.push("person_identity");
  if (handleRows.length) populated.push("identity_handles");
  if (contactFactRows.length) populated.push("contact_facts");
  if (career.length) populated.push("career_history");
  if (boards.length) populated.push("board_seats");
  if (education.length) populated.push("education_history");
  if (familyPublic.length) populated.push("family_ties");
  if (preferences.length) populated.push("person_preferences");
  if (interests.length) populated.push("person_interests");
  if (lifestyle.length) populated.push("lifestyle_signals");
  if (travel.length) populated.push("travel_patterns");
  if (conferences.length) populated.push("conference_attendance");
  if (goals.length) populated.push("goals");
  if (hooks.length) populated.push("conversation_hooks");
  if (appreciation.length) populated.push("appreciation_signals");

  let synthesis: DossierBundle["latest_synthesis"] = null;
  if (synthRow[0]) {
    let parsed: unknown = {};
    try { parsed = JSON.parse(synthRow[0].to_do_business_with_them_json); } catch { /* keep {} */ }
    synthesis = {
      id: synthRow[0].id,
      computed_at: synthRow[0].computed_at,
      to_do_business_with_them: parsed,
      conversation_starters_count: synthRow[0].conversation_starters_count,
      warm_intro_paths_count: synthRow[0].warm_intro_paths_count,
      citations_count: synthRow[0].citations_count,
      llm_model: synthRow[0].llm_model,
    };
  }

  // Privacy-skip metadata for the latest run — surfaces "skipped for
  // privacy" badges in the UI rather than silently omitting the data.
  let privacy_skipped_enrichers: DossierBundle["privacy_skipped_enrichers"] = [];
  const latestRun = await rows<{ id: string }>(env,
    `SELECT id FROM profiler_runs WHERE entity_id = ? ORDER BY started_at DESC LIMIT 1`, entityId);
  if (latestRun[0]) {
    const skipped = await rows<{ enricher_name: string; category: string; skipped_reason: string | null }>(env,
      `SELECT enricher_name, category, skipped_reason
         FROM profiler_enricher_logs
        WHERE run_id = ? AND status = 'skipped' AND skipped_reason = 'privacy_gate'
        ORDER BY enricher_name ASC`,
      latestRun[0].id);
    privacy_skipped_enrichers = skipped.map((s) => ({
      enricher_name: s.enricher_name, category: s.category,
      reason: s.skipped_reason ?? "privacy_gate",
    }));
  }

  const bundle: DossierBundle = {
    entity_id: entityId,
    identity,
    identity_handles: handleRows,
    social_links,
    career_history: career,
    board_seats: boards,
    education_history: education,
    family_ties_public: familyPublic,
    preferences,
    interests,
    lifestyle_signals: lifestyle,
    travel_patterns: travel,
    conference_attendance: conferences,
    goals,
    conversation_hooks: hooks,
    appreciation_signals: appreciation,
    latest_synthesis: synthesis,
    populated_tables: populated,
    privacy_skipped_enrichers,
    cached_at: new Date().toISOString(),
    cache_key: key,
  };

  // Fire-and-forget cache write.
  try {
    await env.SESSIONS.put(key, JSON.stringify(bundle), { expirationTtl: CACHE_TTL_SECONDS });
  } catch { /* best-effort */ }

  return bundle;
}
