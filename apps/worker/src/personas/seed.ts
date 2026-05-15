// Task #46: idempotent loader for the 5 starter personas in
// data/personas-seed.json. Each row has a stable string id (seed-…)
// so re-running this is safe: an existing row with the same id is
// left untouched. Called from /api/personas (GET list) on a single
// fast path the first time the table is empty.

import type { Env } from "../types";
import seedData from "../../data/personas-seed.json";
import { insertPersona } from "./repo";

interface SeedRow {
  id: string;
  name: string;
  kind: "account" | "buyer";
  thesis?: string | null;
  size_min?: number | null;
  size_max?: number | null;
  size_bands_json?: string[];
  geos_json?: string[];
  industries_json?: string[];
  techs_required_json?: string[];
  techs_preferred_json?: string[];
  techs_excluded_json?: string[];
  signal_kinds_json?: string[];
  buyer_titles_json?: string[];
  buyer_seniority_json?: string[];
  buyer_departments_json?: string[];
  hard_filters_json?: Record<string, unknown>;
  weights_json?: Record<string, number>;
}

function jsonOrNull(v: unknown): string | null {
  if (v == null) return null;
  return JSON.stringify(v);
}

export async function ensurePersonasSeeded(env: Env): Promise<{ inserted: number }> {
  const existing = await env.DB.prepare(`SELECT COUNT(*) AS c FROM personas`).first<{ c: number }>();
  if ((existing?.c ?? 0) > 0) return { inserted: 0 };
  let inserted = 0;
  for (const p of seedData as SeedRow[]) {
    const exists = await env.DB.prepare(`SELECT id FROM personas WHERE id = ?`).bind(p.id).first<{ id: string }>();
    if (exists) continue;
    await insertPersona(env, {
      name: p.name,
      kind: p.kind,
      thesis: p.thesis ?? null,
      size_min: p.size_min ?? null,
      size_max: p.size_max ?? null,
      size_bands_json: jsonOrNull(p.size_bands_json),
      geos_json: jsonOrNull(p.geos_json),
      industries_json: jsonOrNull(p.industries_json),
      techs_required_json: jsonOrNull(p.techs_required_json),
      techs_preferred_json: jsonOrNull(p.techs_preferred_json),
      techs_excluded_json: jsonOrNull(p.techs_excluded_json),
      signal_kinds_json: jsonOrNull(p.signal_kinds_json),
      buyer_titles_json: jsonOrNull(p.buyer_titles_json),
      buyer_seniority_json: jsonOrNull(p.buyer_seniority_json),
      buyer_departments_json: jsonOrNull(p.buyer_departments_json),
      hard_filters_json: jsonOrNull(p.hard_filters_json),
      weights_json: jsonOrNull(p.weights_json),
    } as Parameters<typeof insertPersona>[1], "system", p.id);
    inserted += 1;
  }
  return { inserted };
}
