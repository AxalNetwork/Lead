// Task #52: classify free-form buyer titles to the seeded role taxonomy.
//
// Buyers are imported from many sources (LinkedIn-style scrapes, manual
// entry, CRM exports) so `title` arrives as free-form strings like
// "Sr. Staff Product Mgr.", "Head of Eng", "VP, People Ops". Without a
// canonical mapping the role / seniority / decision-maker filters on
// the accounts page can't index buyers and the persona-fit module
// under-counts coverage.
//
// The classifier is intentionally simple: normalize the title, then
// substring-match it against the lowercased aliases stored in
// `role_taxonomy.aliases_json` (seeded from data/roles.json). The
// longest matching alias wins so "senior product manager" prefers
// `product_manager` over a stray match on "manager". When a row
// matches we copy `role_taxonomy.{seniority,department,decision_maker}`
// onto the buyer so downstream filters/analytics see consistent
// values regardless of how the source phrased the title.

import type { RoleTaxonomyRow } from "./fit";

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/&/g, " and "],
  [/\bsr\.?\b/g, "senior"],
  [/\bjr\.?\b/g, "junior"],
  [/\bmgr\.?\b/g, "manager"],
  [/\bdir\.?\b/g, "director"],
  [/\bsvp\b/g, "vp"],
  [/\bevp\b/g, "vp"],
  [/\bengr\.?\b/g, "engineer"],
  [/\beng\.?\b(?!ineer)/g, "engineering"],
  [/\bops\b/g, "operations"],
  [/\bhr\b/g, "human resources"],
  [/\bgm\b/g, "general manager"],
  [/\bg\.?m\.?\b/g, "general manager"],
];

export function normalizeTitle(raw: string): string {
  let s = raw.toLowerCase();
  // Replace anything that isn't a letter/number/space/&/./- with a space
  s = s.replace(/[^\p{L}\p{N}\s&./-]/gu, " ");
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  // Collapse separators that don't carry meaning
  s = s.replace(/[./-]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export interface ClassifyResult {
  role_slug: string;
  seniority: string | null;
  department: string | null;
  is_decision_maker: number;
  matched_alias: string;
}

function parseAliases(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x).toLowerCase().trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function aliasMatches(title: string, alias: string): boolean {
  if (!alias) return false;
  if (title === alias) return true;
  // Word-boundary-ish containment: alias must sit between space/start/end.
  const idx = title.indexOf(alias);
  if (idx < 0) return false;
  const before = idx === 0 ? " " : title.charAt(idx - 1);
  const after = idx + alias.length >= title.length ? " " : title.charAt(idx + alias.length);
  return before === " " && after === " ";
}

export function classifyTitle(
  title: string | null | undefined,
  taxonomy: Map<string, RoleTaxonomyRow>,
): ClassifyResult | null {
  if (!title) return null;
  const norm = " " + normalizeTitle(title) + " ";
  if (norm.trim().length === 0) return null;
  let best: ClassifyResult | null = null;
  let bestLen = 0;
  for (const row of taxonomy.values()) {
    for (const alias of parseAliases(row.aliases_json)) {
      const padded = " " + alias + " ";
      if (norm.includes(padded) || aliasMatches(norm.trim(), alias)) {
        if (alias.length > bestLen) {
          best = {
            role_slug: row.slug,
            seniority: row.seniority,
            department: row.department,
            is_decision_maker: row.decision_maker ? 1 : 0,
            matched_alias: alias,
          };
          bestLen = alias.length;
        }
      }
    }
  }
  return best;
}

// Convenience for callers that have an Env handle. Loads the in-memory
// taxonomy map (slug -> row) once per call.
export async function loadRoleTaxonomyMap(
  env: { DB: { prepare: (s: string) => { all: <T>() => Promise<{ results?: T[] }> } } },
): Promise<Map<string, RoleTaxonomyRow>> {
  const out = new Map<string, RoleTaxonomyRow>();
  try {
    const r = await env.DB.prepare(
      `SELECT slug, department, seniority, decision_maker, aliases_json FROM role_taxonomy`,
    ).all<RoleTaxonomyRow>();
    for (const row of r.results ?? []) out.set(row.slug, row);
  } catch (e) {
    console.warn("loadRoleTaxonomyMap failed", (e as Error).message);
  }
  return out;
}
