import type { Env } from "../types";
import type { TagInput, Taxonomy } from "./model";

export async function addTag(env: Env, t: TagInput): Promise<void> {
  if (!t.entity_id || !t.slug) return;
  const slug = String(t.slug).trim().toLowerCase();
  if (!slug) return;
  try {
    await env.DB.prepare(
      `INSERT INTO entity_tags (entity_id, taxonomy, slug, weight, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, taxonomy, slug)
       DO UPDATE SET weight = MAX(weight, excluded.weight)`,
    ).bind(t.entity_id, t.taxonomy, slug, t.weight ?? 1, t.source ?? null).run();
  } catch (e) {
    console.warn("addTag failed", t.taxonomy, slug, (e as Error).message);
  }
}

export async function addTagsFromJsonArray(
  env: Env,
  entityId: string,
  taxonomy: Taxonomy,
  rawJsonArray: string | null | undefined,
  source: string,
): Promise<number> {
  if (!rawJsonArray) return 0;
  let arr: unknown;
  try { arr = JSON.parse(rawJsonArray); } catch { return 0; }
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const v of arr) {
    if (typeof v !== "string") continue;
    await addTag(env, { entity_id: entityId, taxonomy, slug: v, source });
    n += 1;
  }
  return n;
}
