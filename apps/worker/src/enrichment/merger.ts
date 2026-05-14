// Merge per-provider patches into a single LeadPatch.
// - Higher provider.priority wins when the same scalar field is proposed twice.
// - Array-typed fields (alt_emails_json, languages_json, companies_json,
//   sector_focus_json, tags_json, board_seats_json, awards_json, exits_json)
//   are unioned (deduped, capped) keeping every source.
// - Fields listed in `lockedFields` (manually edited by an operator) are never
//   overwritten.

import type { LeadPatch, Lead } from "../db/leads.types";

const ARRAY_FIELDS: ReadonlyArray<keyof LeadPatch> = [
  "alt_emails_json", "languages_json", "companies_json",
  "sector_focus_json", "tags_json", "board_seats_json",
  "awards_json", "exits_json",
];

export interface ProviderPatch {
  provider: string;
  priority: number;
  patch: LeadPatch;
}

function parseArr(v: unknown): unknown[] {
  if (!v) return [];
  if (typeof v === "string") {
    try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; }
  }
  return Array.isArray(v) ? v : [];
}

function dedupeArr(arr: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of arr) {
    const key = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.slice(0, 50);
}

export function mergePatches(
  before: Lead,
  patches: ProviderPatch[],
  lockedFields: ReadonlyArray<string> = [],
): { patch: LeadPatch; sourceByField: Record<string, string> } {
  // Sort highest-priority first so first-write-wins for scalars.
  const ordered = [...patches].sort((a, b) => b.priority - a.priority);
  const out: LeadPatch = {};
  const sourceByField: Record<string, string> = {};
  const beforeRec = before as unknown as Record<string, unknown>;

  for (const { provider, patch } of ordered) {
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") continue;
      if (lockedFields.includes(k)) continue;
      const key = k as keyof LeadPatch;
      if (ARRAY_FIELDS.includes(key)) {
        const merged = dedupeArr([...parseArr(beforeRec[k]), ...parseArr((out as Record<string, unknown>)[k]), ...parseArr(v)]);
        (out as Record<string, unknown>)[k] = JSON.stringify(merged);
        sourceByField[k] = sourceByField[k] ? `${sourceByField[k]}+${provider}` : provider;
      } else {
        if (k in out) continue; // higher-priority already set
        (out as Record<string, unknown>)[k] = v;
        sourceByField[k] = provider;
      }
    }
  }
  return { patch: out, sourceByField };
}
