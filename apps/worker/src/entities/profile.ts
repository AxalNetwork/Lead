// Task #4: EntityService write helpers for the rich person profile.
//
// Every helper:
//   1. Validates input against the typed shape (profile-shapes.ts).
//   2. Acquires the per-entity DO lock (EntityLock /acquire) so concurrent
//      scrapers / OSINT / agent calls don't race on the same entity_id.
//   3. Upserts the structured row using a stable natural key
//      (ON CONFLICT(...) DO UPDATE).
//   4. Mirrors a canonical row into `facts` via insertFact — the fact's
//      hash dedupe key is sha256(entity|predicate|value|source_url) so the
//      second call with identical content updates `observed_at` rather
//      than creating a duplicate row.
//
// Public-signal constraint: every helper except `setPersonIdentity` (which
// allows operator-asserted rows with isOperatorAsserted=true) refuses to
// write without a source_url.

import type { Env } from "../types";
import { sha256 } from "./normalize";
import { enqueueSummaryRebuild } from "./summaryQueue";
import {
  EMITTED_PREDICATES,
  PREDICATE_MAP,
} from "./profile-predicates";
import type {
  AppreciationSignalInput,
  BoardSeatInput,
  CareerEntryInput,
  ConferenceAttendanceInput,
  ConversationHookInput,
  EducationInput,
  FamilyTieInput,
  GoalInput,
  IdentityInput,
  InterestInput,
  LifestyleSignalInput,
  PreferenceInput,
  TravelPatternInput,
} from "./profile-shapes";

// ---- Internal: per-entity lock (token mutex via EntityLock DO) -----------
//
// Mirrors the OSINT resolver's acquire/release pattern so all rich-profile
// writes for a given entity_id serialize against OSINT, dual-write, and
// any other caller that already uses the same DO id-namespace.
async function withProfileLock<T>(
  env: Env,
  entityId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!env.ENTITY_LOCK) return await fn();
  const stub = env.ENTITY_LOCK.get(env.ENTITY_LOCK.idFromName(entityId));
  const token = crypto.randomUUID();
  let acquired = false;
  try {
    const res = await stub.fetch("https://lock/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ttlMs: 60_000 }),
    });
    acquired = res.ok;
  } catch { /* lock unavailable – proceed best-effort */ }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        await stub.fetch("https://lock/release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
      } catch { /* ignore */ }
    }
  }
}

// ---- Internal: mirror a structured row into `facts` ---------------------
//
// Centralized projection so every helper produces consistent fact rows.
//
// Dedupe contract (task spec): natural key is (entity_id, predicate,
// source_url) — independent of value. Re-observing the same predicate
// from the same source_url MUST upsert the existing fact (new value,
// refreshed observed_at) rather than create a second row. The hash we
// compute here covers ONLY those three fields, and UNIQUE(hash) on
// `facts` (migration 201) turns a collision into our UPDATE path.
//
// We bypass `insertFact` for the mirror path because its hash includes
// the value (which is correct for raw scraper writes but wrong here —
// it would let value drift create duplicate (entity, predicate, source)
// rows). The summary-rebuild enqueue is still triggered.
//
// Asserts the predicate exists in the registry — catches typos at
// runtime and is defense-in-depth backup to the smoke-test enforcement
// of EMITTED_PREDICATES ⊆ registry.
async function mirrorFact(
  env: Env,
  args: {
    entityId: string;
    predicate: string;
    sourceUrl: string;
    valueJson?: unknown;
    valueText?: string | null;
    valueNumber?: number | null;
    confidence?: number;
    observedAt?: string;
  },
): Promise<void> {
  if (!PREDICATE_MAP[args.predicate]) {
    throw new Error(`profile.mirrorFact: predicate "${args.predicate}" is not in PREDICATE_REGISTRY`);
  }
  const hash = await sha256(`${args.entityId}|${args.predicate}|${args.sourceUrl}`);
  const valueText = args.valueText ?? null;
  const valueNumber = args.valueNumber ?? null;
  const valueJsonStr = args.valueJson != null ? JSON.stringify(args.valueJson) : null;
  const confidence = args.confidence ?? 1.0;
  const now = args.observedAt ?? new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO facts (
         id, entity_id, predicate, value_text, value_number, value_json,
         value_entity_id, source_kind, source, evidence_url, confidence,
         observed_at, valid_from, valid_to, is_current, hash
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'enrichment', ?, ?, ?, ?, NULL, NULL, 1, ?)`,
    ).bind(
      crypto.randomUUID(),
      args.entityId,
      args.predicate,
      valueText,
      valueNumber,
      valueJsonStr,
      args.sourceUrl,
      args.sourceUrl,
      confidence,
      now,
      hash,
    ).run();
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) {
      await env.DB.prepare(
        `UPDATE facts
            SET value_text = ?, value_number = ?, value_json = ?,
                confidence = MAX(confidence, ?),
                observed_at = ?, is_current = 1
          WHERE hash = ?`,
      ).bind(valueText, valueNumber, valueJsonStr, confidence, now, hash).run();
    } else {
      throw e;
    }
  }
  try { await enqueueSummaryRebuild(env, args.entityId); } catch { /* best-effort */ }
}

function requireSourceUrl(helper: string, url: string | null | undefined): string {
  if (!url || typeof url !== "string" || url.trim().length === 0) {
    throw new Error(`profile.${helper}: source_url is required (public-signal-only constraint)`);
  }
  return url;
}

function requireNonEmpty(helper: string, field: string, v: string | null | undefined): string {
  if (!v || typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`profile.${helper}: ${field} is required`);
  }
  return v.trim();
}

function nowIso(): string { return new Date().toISOString(); }

// =========================================================================
// 1. setPersonIdentity — upsert on entity_id.
// =========================================================================
export async function setPersonIdentity(env: Env, input: IdentityInput): Promise<void> {
  requireNonEmpty("setPersonIdentity", "entityId", input.entityId);
  const isOperator = input.isOperatorAsserted === true;
  if (!isOperator) requireSourceUrl("setPersonIdentity", input.sourceUrl);
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO person_identity (
         entity_id, full_name, preferred_name, pronouns_json, birth_year,
         nationality, languages_json, timezone, location_city, location_country,
         headshot_url, source_url, is_operator_asserted, confidence,
         observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         full_name        = COALESCE(excluded.full_name, person_identity.full_name),
         preferred_name   = COALESCE(excluded.preferred_name, person_identity.preferred_name),
         pronouns_json    = COALESCE(excluded.pronouns_json, person_identity.pronouns_json),
         birth_year       = COALESCE(excluded.birth_year, person_identity.birth_year),
         nationality      = COALESCE(excluded.nationality, person_identity.nationality),
         languages_json   = COALESCE(excluded.languages_json, person_identity.languages_json),
         timezone         = COALESCE(excluded.timezone, person_identity.timezone),
         location_city    = COALESCE(excluded.location_city, person_identity.location_city),
         location_country = COALESCE(excluded.location_country, person_identity.location_country),
         headshot_url     = COALESCE(excluded.headshot_url, person_identity.headshot_url),
         source_url       = COALESCE(excluded.source_url, person_identity.source_url),
         is_operator_asserted = MAX(excluded.is_operator_asserted, person_identity.is_operator_asserted),
         confidence       = MAX(excluded.confidence, person_identity.confidence),
         observed_at      = excluded.observed_at,
         updated_at       = excluded.updated_at`,
    ).bind(
      input.entityId,
      input.fullName ?? null,
      input.preferredName ?? null,
      input.pronouns ? JSON.stringify(input.pronouns) : null,
      input.birthYear ?? null,
      input.nationality ?? null,
      input.languages ? JSON.stringify(input.languages) : null,
      input.timezone ?? null,
      input.locationCity ?? null,
      input.locationCountry ?? null,
      input.headshotUrl ?? null,
      input.sourceUrl ?? null,
      isOperator ? 1 : 0,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate: "person.identity",
      sourceUrl: input.sourceUrl ?? "operator://asserted",
      valueJson: {
        full_name: input.fullName ?? null,
        preferred_name: input.preferredName ?? null,
        pronouns: input.pronouns ?? null,
        birth_year: input.birthYear ?? null,
        nationality: input.nationality ?? null,
        languages: input.languages ?? null,
        timezone: input.timezone ?? null,
        location_city: input.locationCity ?? null,
        location_country: input.locationCountry ?? null,
        headshot_url: input.headshotUrl ?? null,
        is_operator_asserted: isOperator,
      },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 2. addCareerEntry — natural key (entity_id, organization_*, started_at).
// =========================================================================
export async function addCareerEntry(env: Env, input: CareerEntryInput): Promise<void> {
  requireNonEmpty("addCareerEntry", "entityId", input.entityId);
  requireNonEmpty("addCareerEntry", "organizationName", input.organizationName);
  const sourceUrl = requireSourceUrl("addCareerEntry", input.sourceUrl);
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO career_history (
         id, entity_id, organization_entity_id, organization_name, role_title,
         seniority, department, started_at, ended_at, is_current, summary,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, COALESCE(organization_entity_id,''), organization_name, COALESCE(started_at,'')) DO UPDATE SET
         role_title  = COALESCE(excluded.role_title, career_history.role_title),
         seniority   = COALESCE(excluded.seniority,  career_history.seniority),
         department  = COALESCE(excluded.department, career_history.department),
         ended_at    = COALESCE(excluded.ended_at,   career_history.ended_at),
         is_current  = excluded.is_current,
         summary     = COALESCE(excluded.summary,    career_history.summary),
         confidence  = MAX(excluded.confidence, career_history.confidence),
         observed_at = excluded.observed_at,
         updated_at  = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.organizationEntityId ?? null,
      input.organizationName,
      input.roleTitle ?? null,
      input.seniority ?? null,
      input.department ?? null,
      input.startedAt ?? null,
      input.endedAt ?? null,
      input.isCurrent ? 1 : 0,
      input.summary ?? null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate: "person.career",
      sourceUrl,
      valueJson: {
        organization_entity_id: input.organizationEntityId ?? null,
        organization_name: input.organizationName,
        role_title: input.roleTitle ?? null,
        seniority: input.seniority ?? null,
        department: input.department ?? null,
        started_at: input.startedAt ?? null,
        ended_at: input.endedAt ?? null,
        is_current: input.isCurrent === true,
      },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 3. addBoardSeat — natural key (entity_id, organization_name, started_at).
// =========================================================================
export async function addBoardSeat(env: Env, input: BoardSeatInput): Promise<void> {
  requireNonEmpty("addBoardSeat", "entityId", input.entityId);
  requireNonEmpty("addBoardSeat", "organizationName", input.organizationName);
  const sourceUrl = requireSourceUrl("addBoardSeat", input.sourceUrl);
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO board_seats (
         id, entity_id, organization_entity_id, organization_name, role,
         is_independent, committee, started_at, ended_at,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, organization_name, COALESCE(started_at,'')) DO UPDATE SET
         organization_entity_id = COALESCE(excluded.organization_entity_id, board_seats.organization_entity_id),
         role           = COALESCE(excluded.role, board_seats.role),
         is_independent = excluded.is_independent,
         committee      = COALESCE(excluded.committee, board_seats.committee),
         ended_at       = COALESCE(excluded.ended_at, board_seats.ended_at),
         confidence     = MAX(excluded.confidence, board_seats.confidence),
         observed_at    = excluded.observed_at,
         updated_at     = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.organizationEntityId ?? null,
      input.organizationName,
      input.role ?? null,
      input.isIndependent ? 1 : 0,
      input.committee ?? null,
      input.startedAt ?? null,
      input.endedAt ?? null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate: "person.board_seat",
      sourceUrl,
      valueJson: {
        organization_entity_id: input.organizationEntityId ?? null,
        organization_name: input.organizationName,
        role: input.role ?? null,
        is_independent: input.isIndependent === true,
        committee: input.committee ?? null,
        started_at: input.startedAt ?? null,
        ended_at: input.endedAt ?? null,
      },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 4. addEducation — natural key (entity_id, institution, degree, ended_year).
// =========================================================================
export async function addEducation(env: Env, input: EducationInput): Promise<void> {
  requireNonEmpty("addEducation", "entityId", input.entityId);
  requireNonEmpty("addEducation", "institution", input.institution);
  const sourceUrl = requireSourceUrl("addEducation", input.sourceUrl);
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO education_history (
         id, entity_id, institution, degree, field, started_year, ended_year,
         honors, source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, institution, COALESCE(degree,''), COALESCE(ended_year,0)) DO UPDATE SET
         field        = COALESCE(excluded.field, education_history.field),
         started_year = COALESCE(excluded.started_year, education_history.started_year),
         honors       = COALESCE(excluded.honors, education_history.honors),
         confidence   = MAX(excluded.confidence, education_history.confidence),
         observed_at  = excluded.observed_at,
         updated_at   = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.institution,
      input.degree ?? null,
      input.field ?? null,
      input.startedYear ?? null,
      input.endedYear ?? null,
      input.honors ?? null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate: "person.education",
      sourceUrl,
      valueJson: {
        institution: input.institution,
        degree: input.degree ?? null,
        field: input.field ?? null,
        started_year: input.startedYear ?? null,
        ended_year: input.endedYear ?? null,
        honors: input.honors ?? null,
      },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 5. addFamilyTie — natural key (entity_id, relation_type, related_name).
//    Private (is_public=false) rows MUST be excluded from public APIs and
//    from the agent's retrievable context at the route layer (out of scope
//    for this helper).
// =========================================================================
export async function addFamilyTie(env: Env, input: FamilyTieInput): Promise<void> {
  requireNonEmpty("addFamilyTie", "entityId", input.entityId);
  requireNonEmpty("addFamilyTie", "relationType", input.relationType);
  requireNonEmpty("addFamilyTie", "relatedName", input.relatedName);
  const sourceUrl = requireSourceUrl("addFamilyTie", input.sourceUrl);
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO family_ties (
         id, entity_id, relation_type, related_name, related_entity_id, notes,
         is_public, source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, relation_type, related_name) DO UPDATE SET
         related_entity_id = COALESCE(excluded.related_entity_id, family_ties.related_entity_id),
         notes      = COALESCE(excluded.notes, family_ties.notes),
         is_public  = excluded.is_public,
         confidence = MAX(excluded.confidence, family_ties.confidence),
         observed_at = excluded.observed_at,
         updated_at  = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.relationType,
      input.relatedName,
      input.relatedEntityId ?? null,
      input.notes ?? null,
      input.isPublic ? 1 : 0,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate: "person.family_tie",
      sourceUrl,
      valueJson: {
        relation_type: input.relationType,
        related_name: input.relatedName,
        related_entity_id: input.relatedEntityId ?? null,
        notes: input.notes ?? null,
        is_public: input.isPublic === true,
      },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 6. addPreference — upsert on (entity_id, preference_key).
//    Mirrors to person.preference.{preferenceKey}; that dynamic predicate
//    MUST exist in the registry (validated in mirrorFact + smoke test).
// =========================================================================
export async function addPreference(env: Env, input: PreferenceInput): Promise<void> {
  requireNonEmpty("addPreference", "entityId", input.entityId);
  requireNonEmpty("addPreference", "preferenceKey", input.preferenceKey);
  const sourceUrl = requireSourceUrl("addPreference", input.sourceUrl);
  const predicate = `person.preference.${input.preferenceKey}`;
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO person_preferences (
         id, entity_id, preference_key, value_text, value_json,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, preference_key) DO UPDATE SET
         value_text  = COALESCE(excluded.value_text, person_preferences.value_text),
         value_json  = COALESCE(excluded.value_json, person_preferences.value_json),
         source_url  = excluded.source_url,
         confidence  = MAX(excluded.confidence, person_preferences.confidence),
         observed_at = excluded.observed_at,
         updated_at  = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.preferenceKey,
      input.valueText ?? null,
      input.valueJson ? JSON.stringify(input.valueJson) : null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate,
      sourceUrl,
      valueText: input.valueText ?? null,
      valueJson: input.valueJson ?? null,
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 7. addInterest — natural key (entity_id, interest_category, interest_value).
// =========================================================================
export async function addInterest(env: Env, input: InterestInput): Promise<void> {
  requireNonEmpty("addInterest", "entityId", input.entityId);
  requireNonEmpty("addInterest", "interestCategory", input.interestCategory);
  requireNonEmpty("addInterest", "interestValue", input.interestValue);
  const sourceUrl = requireSourceUrl("addInterest", input.sourceUrl);
  const predicate = `person.interest.${input.interestCategory}`;
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO person_interests (
         id, entity_id, interest_category, interest_value, weight,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, interest_category, interest_value) DO UPDATE SET
         weight      = MAX(excluded.weight, person_interests.weight),
         confidence  = MAX(excluded.confidence, person_interests.confidence),
         observed_at = excluded.observed_at,
         updated_at  = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.interestCategory,
      input.interestValue,
      input.weight ?? 1.0,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate,
      sourceUrl,
      valueText: input.interestValue,
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 8. addLifestyleSignal — natural key (entity_id, signal_key, observed_at).
// =========================================================================
export async function addLifestyleSignal(env: Env, input: LifestyleSignalInput): Promise<void> {
  requireNonEmpty("addLifestyleSignal", "entityId", input.entityId);
  requireNonEmpty("addLifestyleSignal", "signalKey", input.signalKey);
  const sourceUrl = requireSourceUrl("addLifestyleSignal", input.sourceUrl);
  const predicate = `person.lifestyle.${input.signalKey}`;
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO lifestyle_signals (
         id, entity_id, signal_key, value_text, value_json,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, signal_key) DO UPDATE SET
         value_text  = COALESCE(excluded.value_text, lifestyle_signals.value_text),
         value_json  = COALESCE(excluded.value_json, lifestyle_signals.value_json),
         source_url  = excluded.source_url,
         confidence  = MAX(excluded.confidence, lifestyle_signals.confidence),
         observed_at = excluded.observed_at,
         updated_at  = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.signalKey,
      input.valueText ?? null,
      input.valueJson ? JSON.stringify(input.valueJson) : null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate,
      sourceUrl,
      valueText: input.valueText ?? null,
      valueJson: input.valueJson ?? null,
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 9. addTravelPattern — natural key (entity_id, pattern_kind, place, starts_at).
// =========================================================================
export async function addTravelPattern(env: Env, input: TravelPatternInput): Promise<void> {
  requireNonEmpty("addTravelPattern", "entityId", input.entityId);
  requireNonEmpty("addTravelPattern", "patternKind", input.patternKind);
  requireNonEmpty("addTravelPattern", "place", input.place);
  const sourceUrl = requireSourceUrl("addTravelPattern", input.sourceUrl);
  const predicate = `person.travel.${input.patternKind}`;
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO travel_patterns (
         id, entity_id, pattern_kind, place, country_iso2, starts_at, ends_at,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, pattern_kind, place, COALESCE(starts_at,'')) DO UPDATE SET
         country_iso2 = COALESCE(excluded.country_iso2, travel_patterns.country_iso2),
         ends_at      = COALESCE(excluded.ends_at, travel_patterns.ends_at),
         confidence   = MAX(excluded.confidence, travel_patterns.confidence),
         observed_at  = excluded.observed_at,
         updated_at   = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.patternKind,
      input.place,
      input.countryIso2 ?? null,
      input.startsAt ?? null,
      input.endsAt ?? null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate,
      sourceUrl,
      valueText: input.place,
      valueJson: {
        country_iso2: input.countryIso2 ?? null,
        starts_at: input.startsAt ?? null,
        ends_at: input.endsAt ?? null,
      },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 10. addConferenceAttendance — UNIQUE(entity_id, conference_name, year).
// =========================================================================
export async function addConferenceAttendance(env: Env, input: ConferenceAttendanceInput): Promise<void> {
  requireNonEmpty("addConferenceAttendance", "entityId", input.entityId);
  requireNonEmpty("addConferenceAttendance", "conferenceName", input.conferenceName);
  if (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2100) {
    throw new Error("profile.addConferenceAttendance: year must be a 4-digit integer");
  }
  const sourceUrl = requireSourceUrl("addConferenceAttendance", input.sourceUrl);
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO conference_attendance (
         id, entity_id, conference_name, year, role, session_topic, city, country_iso2,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, conference_name, year) DO UPDATE SET
         role          = COALESCE(excluded.role, conference_attendance.role),
         session_topic = COALESCE(excluded.session_topic, conference_attendance.session_topic),
         city          = COALESCE(excluded.city, conference_attendance.city),
         country_iso2  = COALESCE(excluded.country_iso2, conference_attendance.country_iso2),
         confidence    = MAX(excluded.confidence, conference_attendance.confidence),
         observed_at   = excluded.observed_at,
         updated_at    = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.conferenceName,
      input.year,
      input.role ?? null,
      input.sessionTopic ?? null,
      input.city ?? null,
      input.countryIso2 ?? null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate: "person.conference",
      sourceUrl,
      valueJson: {
        conference_name: input.conferenceName,
        year: input.year,
        role: input.role ?? null,
        session_topic: input.sessionTopic ?? null,
        city: input.city ?? null,
        country_iso2: input.countryIso2 ?? null,
      },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 11. addGoal — natural key (entity_id, goal_kind, goal_text).
// =========================================================================
export async function addGoal(env: Env, input: GoalInput): Promise<void> {
  requireNonEmpty("addGoal", "entityId", input.entityId);
  requireNonEmpty("addGoal", "goalKind", input.goalKind);
  requireNonEmpty("addGoal", "goalText", input.goalText);
  const sourceUrl = requireSourceUrl("addGoal", input.sourceUrl);
  const predicate = `person.goal.${input.goalKind}`;
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO person_goals (
         id, entity_id, goal_kind, goal_text, target_date,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, goal_kind, goal_text) DO UPDATE SET
         target_date = COALESCE(excluded.target_date, person_goals.target_date),
         confidence  = MAX(excluded.confidence, person_goals.confidence),
         observed_at = excluded.observed_at,
         updated_at  = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.goalKind,
      input.goalText,
      input.targetDate ?? null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate,
      sourceUrl,
      valueText: input.goalText,
      valueJson: { target_date: input.targetDate ?? null },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 12. addConversationHook — natural key (entity_id, hook_kind, hook_text).
// =========================================================================
export async function addConversationHook(env: Env, input: ConversationHookInput): Promise<void> {
  requireNonEmpty("addConversationHook", "entityId", input.entityId);
  requireNonEmpty("addConversationHook", "hookKind", input.hookKind);
  requireNonEmpty("addConversationHook", "hookText", input.hookText);
  const sourceUrl = requireSourceUrl("addConversationHook", input.sourceUrl);
  const predicate = `person.hook.${input.hookKind}`;
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO conversation_hooks (
         id, entity_id, hook_kind, hook_text, related_entity_id,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, hook_kind, hook_text) DO UPDATE SET
         related_entity_id = COALESCE(excluded.related_entity_id, conversation_hooks.related_entity_id),
         confidence  = MAX(excluded.confidence, conversation_hooks.confidence),
         observed_at = excluded.observed_at,
         updated_at  = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.hookKind,
      input.hookText,
      input.relatedEntityId ?? null,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate,
      sourceUrl,
      valueText: input.hookText,
      valueJson: { related_entity_id: input.relatedEntityId ?? null },
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// =========================================================================
// 13. addAppreciationSignal — natural key (entity_id, signal_kind, signal_text).
// =========================================================================
export async function addAppreciationSignal(env: Env, input: AppreciationSignalInput): Promise<void> {
  requireNonEmpty("addAppreciationSignal", "entityId", input.entityId);
  requireNonEmpty("addAppreciationSignal", "signalKind", input.signalKind);
  requireNonEmpty("addAppreciationSignal", "signalText", input.signalText);
  const sourceUrl = requireSourceUrl("addAppreciationSignal", input.sourceUrl);
  const predicate = `person.appreciation.${input.signalKind}`;
  const now = input.observedAt ?? nowIso();
  await withProfileLock(env, input.entityId, async () => {
    await env.DB.prepare(
      `INSERT INTO appreciation_signals (
         id, entity_id, signal_kind, signal_text,
         source_url, confidence, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, signal_kind, signal_text) DO UPDATE SET
         confidence  = MAX(excluded.confidence, appreciation_signals.confidence),
         observed_at = excluded.observed_at,
         updated_at  = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.entityId,
      input.signalKind,
      input.signalText,
      sourceUrl,
      input.confidence ?? 1.0,
      now,
      now,
    ).run();
    await mirrorFact(env, {
      entityId: input.entityId,
      predicate,
      sourceUrl,
      valueText: input.signalText,
      confidence: input.confidence,
      observedAt: now,
    });
  });
}

// EntityService facade — single import surface for callers.
export const EntityService = {
  setPersonIdentity,
  addCareerEntry,
  addBoardSeat,
  addEducation,
  addFamilyTie,
  addPreference,
  addInterest,
  addLifestyleSignal,
  addTravelPattern,
  addConferenceAttendance,
  addGoal,
  addConversationHook,
  addAppreciationSignal,
};

export { EMITTED_PREDICATES };
