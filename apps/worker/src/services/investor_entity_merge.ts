// Task #31 — surface entity-store data in the investor profile read path.
//
// Crawlers write extracted facts (bio, thesis, check sizes, focus, social
// links) into the unified entity store (`facts` / `entity_summary` /
// `channels`), not into the legacy `leads` columns the investor profile
// reads. This helper resolves a lead → its unified entity and returns an
// overlay of those fields so the profile endpoint can fill gaps. The legacy
// `leads` value always wins when present (it carries manual/import authority);
// the overlay only fills nulls/empties.

import type { Env } from "../types";

export interface EntityOverlay {
  bio: string | null;
  thesis: string | null;
  check_size_min_usd: number | null;
  check_size_max_usd: number | null;
  check_size_typical_usd: number | null;
  stage_focus: string[];
  sector_focus: string[];
  geo_focus: string[];
  linkedin_url: string | null;
  twitter_url: string | null;
  github_url: string | null;
  personal_url: string | null;
}

const EMPTY: EntityOverlay = {
  bio: null, thesis: null,
  check_size_min_usd: null, check_size_max_usd: null, check_size_typical_usd: null,
  stage_focus: [], sector_focus: [], geo_focus: [],
  linkedin_url: null, twitter_url: null, github_url: null, personal_url: null,
};

function csvToArr(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

interface SummaryRow {
  check_size_min_usd: number | null;
  check_size_max_usd: number | null;
  sectors_csv: string | null;
  stages_csv: string | null;
  geos_csv: string | null;
  primary_linkedin: string | null;
  primary_domain: string | null;
}

/**
 * Resolve a lead's unified entity and return a best-effort scalar overlay.
 * Best-effort throughout: any missing table/row yields the empty overlay
 * rather than throwing, so the profile endpoint degrades gracefully on
 * fresh installs / test DBs.
 */
export async function loadInvestorEntityOverlay(env: Env, leadId: string): Promise<EntityOverlay> {
  try {
    const map = await env.DB
      .prepare("SELECT entity_id FROM entity_legacy_map WHERE legacy_table = 'leads' AND legacy_id = ? LIMIT 1")
      .bind(leadId)
      .first<{ entity_id: string }>();
    if (!map?.entity_id) return { ...EMPTY };
    const entityId = map.entity_id;

    const overlay: EntityOverlay = { ...EMPTY };

    const summary = await env.DB
      .prepare(
        `SELECT check_size_min_usd, check_size_max_usd, sectors_csv, stages_csv, geos_csv,
                primary_linkedin, primary_domain
           FROM entity_summary WHERE entity_id = ?`,
      )
      .bind(entityId)
      .first<SummaryRow>()
      .catch(() => null);
    if (summary) {
      overlay.check_size_min_usd = summary.check_size_min_usd ?? null;
      overlay.check_size_max_usd = summary.check_size_max_usd ?? null;
      overlay.sector_focus = csvToArr(summary.sectors_csv);
      overlay.stage_focus = csvToArr(summary.stages_csv);
      overlay.geo_focus = csvToArr(summary.geos_csv);
      overlay.linkedin_url = summary.primary_linkedin ?? null;
      overlay.personal_url = summary.primary_domain ? `https://${summary.primary_domain}` : null;
    }

    // Text/number facts that aren't materialized on entity_summary.
    const facts = await env.DB
      .prepare(
        `SELECT predicate, value_text, value_number
           FROM facts
          WHERE entity_id = ? AND is_current = 1
            AND predicate IN ('bio','thesis','check_size_typical_usd','check_size_min_usd','check_size_max_usd')`,
      )
      .bind(entityId)
      .all<{ predicate: string; value_text: string | null; value_number: number | null }>()
      .catch(() => ({ results: [] as Array<{ predicate: string; value_text: string | null; value_number: number | null }> }));
    for (const f of facts.results ?? []) {
      if (f.predicate === "bio" && f.value_text) overlay.bio = f.value_text;
      else if (f.predicate === "thesis" && f.value_text) overlay.thesis = f.value_text;
      else if (f.predicate === "check_size_typical_usd" && f.value_number != null) overlay.check_size_typical_usd = f.value_number;
      else if (f.predicate === "check_size_min_usd" && f.value_number != null && overlay.check_size_min_usd == null) overlay.check_size_min_usd = f.value_number;
      else if (f.predicate === "check_size_max_usd" && f.value_number != null && overlay.check_size_max_usd == null) overlay.check_size_max_usd = f.value_number;
    }

    // Social handles live in the channels table (primary first).
    const chans = await env.DB
      .prepare(
        `SELECT kind, canonical FROM channels
          WHERE entity_id = ? AND kind IN ('linkedin','twitter','github','website')
          ORDER BY is_primary DESC`,
      )
      .bind(entityId)
      .all<{ kind: string; canonical: string }>()
      .catch(() => ({ results: [] as Array<{ kind: string; canonical: string }> }));
    for (const ch of chans.results ?? []) {
      if (ch.kind === "linkedin" && !overlay.linkedin_url) overlay.linkedin_url = ch.canonical;
      else if (ch.kind === "twitter" && !overlay.twitter_url) overlay.twitter_url = ch.canonical;
      else if (ch.kind === "github" && !overlay.github_url) overlay.github_url = ch.canonical;
      else if (ch.kind === "website" && !overlay.personal_url) overlay.personal_url = ch.canonical;
    }

    return overlay;
  } catch {
    return { ...EMPTY };
  }
}

/** Pick the first non-empty string. */
export function coalesceStr(legacy: string | null | undefined, overlay: string | null): string | null {
  if (legacy != null && String(legacy).trim() !== "") return legacy;
  return overlay;
}

/** Pick the first non-null number. */
export function coalesceNum(legacy: number | null | undefined, overlay: number | null): number | null {
  if (legacy != null) return legacy;
  return overlay;
}

/** Legacy array wins if it has any elements, else the overlay array. */
export function coalesceArr(legacy: string[], overlay: string[]): string[] {
  return legacy.length ? legacy : overlay;
}
