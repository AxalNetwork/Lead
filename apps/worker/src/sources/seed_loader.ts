import type { Env } from "../types";
import { upsertSource } from "./registry";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import seedSourcesJson from "../../data/seed-sources.json";

interface SeedEntry {
  importer?: string;
  kind?: string;
  url?: string;
  label?: string;
  record_type?: string;
  hints?: Record<string, unknown>;
  variant?: string;
  schedule_cron?: string;
}

/**
 * Task #5: on first deploy / on demand, walk `seed-sources.json` and
 * upsert every entry into `source_registry`. Idempotent — existing
 * canonical URLs are skipped. Returns per-row outcomes so the caller
 * can render a summary.
 */
export async function loadSeedSources(env: Env): Promise<{ total: number; created: number; existing: number; errors: Array<{ url: string; error: string }> }> {
  const seed = seedSourcesJson as { sources?: SeedEntry[] };
  const sources = Array.isArray(seed.sources) ? seed.sources : [];
  let created = 0;
  let existing = 0;
  const errors: Array<{ url: string; error: string }> = [];
  for (const row of sources) {
    if (!row || typeof row.url !== "string" || typeof row.importer !== "string") continue;
    const hints: Record<string, unknown> = { ...(row.hints ?? {}) };
    if (row.record_type) hints.record_type = row.record_type;
    if (row.variant) hints.variant = row.variant;
    const role_hint = typeof hints.role_hint === "string" ? hints.role_hint : null;
    const region = typeof hints.region === "string" ? hints.region : null;
    const category = typeof hints.sector === "string" ? hints.sector as string : (row.record_type ?? null);
    try {
      const r = await upsertSource(env, {
        url: row.url,
        importer: row.importer,
        label: row.label ?? null,
        category,
        region,
        role_hint,
        hints,
        schedule_cron: row.schedule_cron ?? null,
        added_by: "seed:bootstrap",
      });
      if ("error" in r) {
        errors.push({ url: row.url, error: r.error });
      } else if (r.created) {
        created += 1;
      } else {
        existing += 1;
      }
    } catch (e) {
      errors.push({ url: row.url, error: (e as Error).message });
    }
  }
  return { total: sources.length, created, existing, errors };
}
