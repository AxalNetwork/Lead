// One-shot DB seeding for the taxonomy tables. JSON in `data/sectors.json`
// and `data/geographies.json` is the source of truth at build time; this
// helper mirrors that data into `tax_sectors` / `tax_geographies` (with
// aliases_json) so consumers that JOIN on those tables see the same set of
// canonical slugs.
//
// Idempotent via INSERT OR IGNORE. Cached in-isolate so it runs once per
// worker instance.

import type { Env } from "../types";
import { listSectors, listGeographies } from "./loader";

let SEEDED_PROMISE: Promise<void> | null = null;

export function ensureTaxonomySeeded(env: Env): Promise<void> {
  if (!SEEDED_PROMISE) {
    SEEDED_PROMISE = (async () => {
      const now = new Date().toISOString();
      const stmts: D1PreparedStatement[] = [];
      for (const s of listSectors()) {
        stmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO tax_sectors (slug, label, parent_slug, aliases_json, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).bind(s.slug, s.label, s.parent_slug ?? null, JSON.stringify(s.aliases ?? []), s.description ?? null, now, now),
        );
      }
      for (const g of listGeographies()) {
        stmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO tax_geographies (slug, label, kind, country_iso2, parent_slug, aliases_json, lat, lng, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(g.slug, g.label, g.kind, g.country_iso2 ?? null, g.parent_slug ?? null, JSON.stringify(g.aliases ?? []), g.lat ?? null, g.lng ?? null, now, now),
        );
      }
      // Chunk to stay well below D1 batch limits.
      const CHUNK = 50;
      for (let i = 0; i < stmts.length; i += CHUNK) {
        await env.DB.batch(stmts.slice(i, i + CHUNK));
      }
    })().catch((e) => { SEEDED_PROMISE = null; throw e; });
  }
  return SEEDED_PROMISE;
}
