// Loads taxonomy seeds from JSON and builds in-memory lookup indexes.
// Sectors: slug → entry, alias → slug.
// Geographies: slug → entry, alias → slug (incl. country names + metros).
// All comparisons are case-insensitive on a normalized form.

import sectorsJson from "../../data/sectors.json";
import geoJson from "../../data/geographies.json";

export interface SectorEntry {
  slug: string;
  label: string;
  parent_slug?: string | null;
  aliases: string[];
  description?: string | null;
}

export interface GeographyEntry {
  slug: string;
  label: string;
  kind: "country" | "metro";
  country_iso2: string | null;
  parent_slug?: string | null;
  aliases: string[];
  lat?: number | null;
  lng?: number | null;
}

function norm(s: string): string {
  return s.trim().toLowerCase().normalize("NFKD").replace(/[^\p{Letter}\p{Number}]+/gu, " ").replace(/\s+/g, " ").trim();
}

const SECTORS_LIST: SectorEntry[] = (sectorsJson as { items: SectorEntry[] }).items.map((s) => ({
  slug: s.slug,
  label: s.label,
  parent_slug: s.parent_slug ?? null,
  aliases: Array.isArray(s.aliases) ? s.aliases : [],
}));

const SECTOR_BY_SLUG = new Map<string, SectorEntry>();
const SECTOR_BY_ALIAS = new Map<string, string>();
for (const s of SECTORS_LIST) {
  SECTOR_BY_SLUG.set(s.slug, s);
  SECTOR_BY_ALIAS.set(norm(s.label), s.slug);
  SECTOR_BY_ALIAS.set(norm(s.slug.replace(/_/g, " ")), s.slug);
  for (const a of s.aliases) SECTOR_BY_ALIAS.set(norm(a), s.slug);
}

const GEO_LIST: GeographyEntry[] = [];
const COUNTRIES = (geoJson as { countries: Array<{ iso2: string; label: string; aliases: string[] }> }).countries;
const METROS = (geoJson as { metros: Array<{ slug: string; label: string; country_iso2: string; aliases: string[] }> }).metros;
for (const c of COUNTRIES) {
  GEO_LIST.push({
    slug: c.iso2.toLowerCase(),
    label: c.label,
    kind: "country",
    country_iso2: c.iso2,
    aliases: c.aliases,
  });
}
for (const m of METROS) {
  GEO_LIST.push({
    slug: m.slug,
    label: m.label,
    kind: "metro",
    country_iso2: m.country_iso2,
    parent_slug: m.country_iso2.toLowerCase(),
    aliases: m.aliases,
  });
}

const GEO_BY_SLUG = new Map<string, GeographyEntry>();
const GEO_BY_ALIAS = new Map<string, string>();
for (const g of GEO_LIST) {
  GEO_BY_SLUG.set(g.slug, g);
  GEO_BY_ALIAS.set(norm(g.label), g.slug);
  if (g.kind === "country" && g.country_iso2) {
    GEO_BY_ALIAS.set(norm(g.country_iso2), g.slug);
  }
  for (const a of g.aliases) GEO_BY_ALIAS.set(norm(a), g.slug);
}

export function listSectors(): SectorEntry[] { return SECTORS_LIST.slice(); }
export function listGeographies(): GeographyEntry[] { return GEO_LIST.slice(); }
export function getSector(slug: string): SectorEntry | null { return SECTOR_BY_SLUG.get(slug) ?? null; }
export function getGeography(slug: string): GeographyEntry | null { return GEO_BY_SLUG.get(slug) ?? null; }

/**
 * Resolve a freeform sector string to a canonical slug. Order:
 *  1. exact alias / label / slug-as-words match,
 *  2. word-boundary substring match (longest alias wins).
 */
export function resolveSectorSlug(input: string | null | undefined): string | null {
  if (!input) return null;
  const n = norm(String(input));
  if (!n) return null;
  const exact = SECTOR_BY_ALIAS.get(n);
  if (exact) return exact;
  // Substring: prefer longest alias to avoid 'ai' matching 'ai_' for everything.
  let best: { slug: string; len: number } | null = null;
  for (const [alias, slug] of SECTOR_BY_ALIAS.entries()) {
    if (alias.length < 3) continue;
    if (n.includes(alias) && (!best || alias.length > best.len)) {
      best = { slug, len: alias.length };
    }
  }
  return best?.slug ?? null;
}

/**
 * Resolve a freeform location string to a geography slug. Tries exact match
 * first, then substring (longest alias wins), then country-name fallback.
 * Returns { slug, country_iso2 } so the caller can also stamp country_iso2.
 */
export function resolveGeoSlug(input: string | null | undefined): { slug: string | null; country_iso2: string | null } {
  if (!input) return { slug: null, country_iso2: null };
  const n = norm(String(input));
  if (!n) return { slug: null, country_iso2: null };
  const exact = GEO_BY_ALIAS.get(n);
  if (exact) {
    const e = GEO_BY_SLUG.get(exact)!;
    return { slug: e.slug, country_iso2: e.country_iso2 ?? null };
  }
  let best: { slug: string; len: number } | null = null;
  for (const [alias, slug] of GEO_BY_ALIAS.entries()) {
    if (alias.length < 3) continue;
    if (n.includes(alias) && (!best || alias.length > best.len)) {
      best = { slug, len: alias.length };
    }
  }
  if (best) {
    const e = GEO_BY_SLUG.get(best.slug)!;
    return { slug: e.slug, country_iso2: e.country_iso2 ?? null };
  }
  return { slug: null, country_iso2: null };
}
