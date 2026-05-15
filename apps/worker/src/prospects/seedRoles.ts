// Task #44: one-shot role-taxonomy seeder.
//
// Loads apps/worker/data/roles.json into the role_taxonomy table. Idempotent
// via UPSERT on slug. Called from /api/accounts/_seed-roles (admin-only via
// the existing accessGuard) and from the nightly cron when the table is
// empty.

import type { Env } from "../types";
import rolesJson from "../../data/roles.json";

interface SeedRow {
  slug: string;
  label: string;
  department?: string | null;
  seniority?: string | null;
  decision_maker?: boolean;
  aliases?: string[];
}

const ROLES = rolesJson as SeedRow[];

export async function seedRoleTaxonomy(env: Env): Promise<{ upserted: number; total: number }> {
  let upserted = 0;
  const now = new Date().toISOString();
  for (const r of ROLES) {
    if (!r.slug || !r.label) continue;
    try {
      await env.DB.prepare(
        `INSERT INTO role_taxonomy (slug, label, department, seniority, decision_maker, aliases_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           label = excluded.label,
           department = excluded.department,
           seniority = excluded.seniority,
           decision_maker = excluded.decision_maker,
           aliases_json = excluded.aliases_json,
           updated_at = excluded.updated_at`,
      ).bind(
        r.slug, r.label,
        r.department ?? null, r.seniority ?? null,
        r.decision_maker ? 1 : 0,
        JSON.stringify((r.aliases ?? []).map((a) => a.toLowerCase())),
        now,
      ).run();
      upserted += 1;
    } catch (e) {
      console.warn("seedRoleTaxonomy row failed", r.slug, (e as Error).message);
    }
  }
  return { upserted, total: ROLES.length };
}

export async function ensureRoleTaxonomySeeded(env: Env): Promise<void> {
  try {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM role_taxonomy`).first<{ n: number }>();
    if ((r?.n ?? 0) === 0) await seedRoleTaxonomy(env);
  } catch (e) {
    console.warn("ensureRoleTaxonomySeeded check failed", (e as Error).message);
  }
}

export const SEED_ROLE_COUNT = ROLES.length;
