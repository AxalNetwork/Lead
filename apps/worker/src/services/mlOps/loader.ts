// Task #8: gold dataset loader. Reads the bundled JSON fixtures and
// upserts them into eval_datasets + eval_examples. Idempotent — re-runs
// upsert via (dataset_id, example_key) UNIQUE.

import type { Env } from "../../types";
import pageClassificationJson from "./goldDatasets/page_classification.json";
import csvMappingJson from "./goldDatasets/csv_mapping.json";
import roleInferenceJson from "./goldDatasets/role_inference.json";
import dealExtractionJson from "./goldDatasets/deal_extraction.json";
import entityDedupeJson from "./goldDatasets/entity_dedupe.json";
import founderBackgroundJson from "./goldDatasets/founder_background.json";

export interface GoldDataset {
  task_key: string;
  name: string;
  schema_version: number;
  description?: string;
  examples: { key: string; input: unknown; gold: unknown; notes?: string }[];
}

export const BUNDLED_DATASETS: GoldDataset[] = [
  pageClassificationJson as GoldDataset,
  csvMappingJson as GoldDataset,
  roleInferenceJson as GoldDataset,
  dealExtractionJson as GoldDataset,
  entityDedupeJson as GoldDataset,
  founderBackgroundJson as GoldDataset,
];

export interface LoadResult {
  task_key: string;
  dataset_id: string;
  inserted: number;
  total: number;
  schema_version: number;
}

export async function loadBundledDatasets(env: Env): Promise<LoadResult[]> {
  const out: LoadResult[] = [];
  for (const ds of BUNDLED_DATASETS) {
    out.push(await loadDataset(env, ds));
  }
  return out;
}

export async function loadDataset(env: Env, ds: GoldDataset): Promise<LoadResult> {
  const existing = await env.DB.prepare(
    `SELECT id FROM eval_datasets WHERE task_key = ? AND schema_version = ? LIMIT 1`,
  ).bind(ds.task_key, ds.schema_version).first<{ id: string }>();
  let datasetId: string;
  if (existing) {
    datasetId = existing.id;
  } else {
    datasetId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO eval_datasets (id, task_key, name, schema_version, description, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).bind(datasetId, ds.task_key, ds.name, ds.schema_version, ds.description ?? null).run();
    // Mark prior versions inactive so the runner picks the latest.
    await env.DB.prepare(
      `UPDATE eval_datasets SET active = 0 WHERE task_key = ? AND schema_version < ?`,
    ).bind(ds.task_key, ds.schema_version).run();
  }
  let inserted = 0;
  for (const ex of ds.examples) {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO eval_examples (id, dataset_id, example_key, input_json, gold_output_json, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), datasetId, ex.key,
      JSON.stringify(ex.input), JSON.stringify(ex.gold), ex.notes ?? null,
    ).run();
    if ((r.meta as { changes?: number } | undefined)?.changes) inserted += 1;
  }
  return { task_key: ds.task_key, dataset_id: datasetId, inserted, total: ds.examples.length, schema_version: ds.schema_version };
}
