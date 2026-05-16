// Task #2: Reputability lookup.
//
// Two layers:
//   1. Seed JSON at apps/worker/data/source-reputability.json — the canonical
//      source of truth. Imported at build time.
//   2. source_reputability table in D1 — loaded lazily on first lookup so
//      operators can edit hosts via UI without a redeploy.
//
// Public surface:
//   - getReputability(env, host)      → { score, tier, country } | null
//   - ensureSeeded(env)               → upserts the JSON seed (one-shot, idempotent)
//   - REPUTABILITY_DEFAULT = 0.4      → fallback for unknown hosts

import type { Env } from "../types";

export const REPUTABILITY_DEFAULT = 0.4;

export interface RepEntry {
  score: number;
  tier?: string | null;
  country?: string | null;
  notes?: string | null;
}

let seedCache: Record<string, RepEntry> | null = null;
let seededAtMs = 0;

async function loadSeed(): Promise<Record<string, RepEntry>> {
  if (seedCache) return seedCache;
  try {
    const mod = (await import("../../data/source-reputability.json")) as unknown as { default: Record<string, unknown> };
    const out: Record<string, RepEntry> = {};
    for (const [k, v] of Object.entries(mod.default ?? {})) {
      if (k.startsWith("_")) continue;
      if (typeof v === "number") {
        out[k.toLowerCase()] = { score: v };
      } else if (v && typeof v === "object" && "score" in v) {
        const e = v as { score: number; tier?: string; country?: string | null; notes?: string };
        out[k.toLowerCase()] = { score: Number(e.score) || REPUTABILITY_DEFAULT, tier: e.tier ?? null, country: e.country ?? null, notes: e.notes ?? null };
      }
    }
    seedCache = out;
  } catch {
    seedCache = {};
  }
  return seedCache;
}

// Lowercase apex (drops "www.", subdomain handling left to caller when host is meaningful).
export function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  try {
    if (h.includes("://")) h = new URL(h).hostname;
  } catch { /* fall through */ }
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

// Returns the seed entry, falling back to the parent apex (e.g.
// `pro.theinformation.com` → `theinformation.com`). Pure (no DB).
export function lookupSeed(seed: Record<string, RepEntry>, host: string): RepEntry | null {
  const h = normalizeHost(host);
  if (seed[h]) return seed[h];
  const parts = h.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const apex = parts.slice(i).join(".");
    if (seed[apex]) return seed[apex];
  }
  return null;
}

// DB-backed lookup. Falls back to seed → default.
export async function getReputability(env: Env, host: string): Promise<RepEntry> {
  const h = normalizeHost(host);
  try {
    const row = await env.DB.prepare(
      `SELECT score, tier, country FROM source_reputability WHERE host = ?`,
    ).bind(h).first<{ score: number; tier: string | null; country: string | null }>();
    if (row) return { score: row.score, tier: row.tier, country: row.country };
  } catch { /* table may not exist yet pre-migration */ }
  const seed = await loadSeed();
  const hit = lookupSeed(seed, h);
  if (hit) return hit;
  return { score: REPUTABILITY_DEFAULT, tier: null, country: null };
}

// Idempotent seed → DB upsert. Called once per worker boot (5min cache) by
// the news routes + refresh entry points. Safe under concurrency.
export async function ensureSeeded(env: Env): Promise<{ seeded: number }> {
  if (Date.now() - seededAtMs < 5 * 60 * 1000) return { seeded: 0 };
  const seed = await loadSeed();
  const rows = Object.entries(seed);
  let n = 0;
  for (const [host, e] of rows) {
    try {
      await env.DB.prepare(
        `INSERT INTO source_reputability(host, score, tier, country, notes, updated_at)
         VALUES(?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(host) DO UPDATE SET
           score = excluded.score,
           tier = excluded.tier,
           country = excluded.country,
           notes = excluded.notes,
           updated_at = datetime('now')`,
      ).bind(host, e.score, e.tier ?? null, e.country ?? null, e.notes ?? null).run();
      n++;
    } catch { /* table missing pre-migration → silently skip */ }
  }
  seededAtMs = Date.now();
  return { seeded: n };
}

export function tierFromScore(score: number): string {
  if (score >= 0.95) return "primary";
  if (score >= 0.8) return "major";
  if (score >= 0.6) return "mid";
  if (score >= 0.4) return "blog";
  return "low";
}
