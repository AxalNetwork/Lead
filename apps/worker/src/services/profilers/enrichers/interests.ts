// Task #5 step 4: interests, cuisine, travel enrichers.
//
// All read from already-stored facts where the OSINT/scraper layer
// surfaced public signals (X likes, public Instagram captions, GoodReads
// public shelves, Last.fm public scrobbles, Strava segments, Letterboxd
// public ratings, Yelp reviewer profile, conference attendance, FF mileage
// posts). When the upstream pivot didn't run / found nothing, the
// enricher returns zero writes.

import type { Env } from "../../../types";
import type { InterestCategory, TravelPatternKind } from "../../../entities/profile-shapes";
import { type Enricher, type EnricherResult, type StructuredWrite } from "../types";

interface FactRow {
  predicate: string; value_text: string | null; value_number: number | null;
  value_json: string | null; evidence_url: string | null; observed_at: string;
}

async function factsByPrefix(env: Env, entityId: string, prefix: string): Promise<FactRow[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT predicate, value_text, value_number, value_json, evidence_url, observed_at
         FROM facts WHERE entity_id = ? AND predicate LIKE ?
         ORDER BY observed_at DESC LIMIT 100`,
    ).bind(entityId, `${prefix}%`).all<FactRow>();
    return r.results ?? [];
  } catch { return []; }
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

const INTEREST_PREDICATE_TO_CATEGORY: Record<string, InterestCategory> = {
  "person.interest.topic":  "topic",
  "person.interest.sport":  "sport",
  "person.interest.team":   "team",
  "person.interest.book":   "book",
  "person.interest.author": "author",
  "person.interest.podcast":"podcast",
  "person.interest.music":  "music",
  "person.interest.artist": "artist",
  "person.interest.film":   "film",
  "person.interest.show":   "show",
  "person.interest.hobby":  "hobby",
  "person.interest.cause":  "cause",
};

// =========================================================================
// interestProfiler — promotes person.interest.* facts.
// =========================================================================
export const interestProfiler: Enricher = {
  name: "interestProfiler",
  category: "interests",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await factsByPrefix(env, entityId, "person.interest.");
    const writes: StructuredWrite[] = [];
    const seen = new Set<string>();
    for (const f of facts) {
      const category = INTEREST_PREDICATE_TO_CATEGORY[f.predicate];
      if (!category) continue;
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const value = (v.value as string) ?? f.value_text;
      if (!value) continue;
      const key = `${category}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "interest",
        input: {
          entityId, interestCategory: category, interestValue: value,
          weight: typeof v.weight === "number" ? (v.weight as number) : undefined,
          sourceUrl, confidence: 0.7,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// cuisineProfiler — Yelp + restaurant tags → preferred_cuisines + favorite
// restaurants stored as person.lifestyle.cuisine.* signals.
// =========================================================================
export const cuisineProfiler: Enricher = {
  name: "cuisineProfiler",
  category: "cuisine",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await factsByPrefix(env, entityId, "person.lifestyle.cuisine");
    const writes: StructuredWrite[] = [];
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const detail = (v.detail as string) ?? f.value_text ?? "";
      if (!detail) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "lifestyle",
        input: {
          entityId,
          signalKey: "cuisine",
          valueText: detail,
          valueJson: { detail, frequency: (v.frequency as "weekly" | undefined) },
          sourceUrl, confidence: 0.65,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

const TRAVEL_PREDICATE_TO_KIND: Record<string, TravelPatternKind> = {
  "person.travel.frequent_city": "frequent_city",
  "person.travel.home_base":     "home_base",
  "person.travel.recent_trip":   "recent_trip",
  "person.travel.upcoming_trip": "upcoming_trip",
  "person.travel.airport_hub":   "airport_hub",
};

// =========================================================================
// travelProfiler — Instagram geotags, X check-ins, FF mentions, conference
// attendance → travel_patterns + conference_attendance.
// =========================================================================
export const travelProfiler: Enricher = {
  name: "travelProfiler",
  category: "travel",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const travelFacts = await factsByPrefix(env, entityId, "person.travel.");
    const confFacts = await factsByPrefix(env, entityId, "person.conference");
    const writes: StructuredWrite[] = [];
    const tseen = new Set<string>();
    for (const f of travelFacts) {
      const kind = TRAVEL_PREDICATE_TO_KIND[f.predicate];
      if (!kind) continue;
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const place = (v.place as string) ?? f.value_text;
      if (!place) continue;
      const key = `${kind}|${place.toLowerCase()}`;
      if (tseen.has(key)) continue;
      tseen.add(key);
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "travel",
        input: {
          entityId, patternKind: kind, place,
          countryIso2: (v.country_iso2 as string) ?? null,
          startsAt: (v.starts_at as string) ?? null,
          endsAt: (v.ends_at as string) ?? null,
          sourceUrl, confidence: 0.7,
        },
      });
    }
    const cseen = new Set<string>();
    for (const f of confFacts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const conferenceName = (v.conference_name as string) ?? f.value_text;
      const year = typeof v.year === "number" ? (v.year as number) : 0;
      if (!conferenceName || !year) continue;
      const key = `${conferenceName.toLowerCase()}|${year}`;
      if (cseen.has(key)) continue;
      cseen.add(key);
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "conference",
        input: {
          entityId, conferenceName, year,
          role: (v.role as string) ?? null,
          sessionTopic: (v.session_topic as string) ?? null,
          city: (v.city as string) ?? null,
          countryIso2: (v.country_iso2 as string) ?? null,
          sourceUrl, confidence: 0.7,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

export const interestsCategoryEnrichers: Enricher[] = [interestProfiler, cuisineProfiler, travelProfiler];
