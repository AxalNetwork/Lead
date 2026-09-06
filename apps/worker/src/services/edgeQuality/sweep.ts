// Nightly orchestrator for Task #3: Edge-Quality Scoring + Power-Node
// Detection.
//
// One pass over rel_edges to (re)compute quality_score, then one pass
// over the resulting weighted graph to compute global + per-sector
// PageRank and broker scores. Persists per-edge results in
// rel_edges.{quality_score, quality_signals_json, last_interaction_at}
// and per-entity results in entity_influence. Derived per-entity facts
// (entity.pagerank_score, entity.broker_score) mirror through
// insertFact with source_kind="inferred" per the Task #1 canonical
// write contract.

import type { Env } from "../../types";
import { collectAllSignals } from "./signals";
import { aggregateSignals } from "./aggregate";
import { computeInfluence, type ScoredEdge } from "./influence";
import { insertFact } from "../../entities/facts";
import { logError } from "../../db/error_log";
import { wrapUnknown } from "../../errors";

const EDGE_BATCH = 200;        // edges scored per loop iteration
const EDGE_TICK_CAP = 5000;    // hard ceiling per nightly tick (Task #2 precedent)
const INFLUENCE_EDGE_CAP = 200_000;  // bounded compute ceiling for influence rebuild
const SOURCE = "edge_quality_engine";

export interface SweepResult {
  edges_scored: number;
  entities_ranked: number;
  sectors_ranked: number;
  power_nodes: number;
  full_pass_wrapped: boolean;
  influence_loaded_edges: number;
  influence_truncated: boolean;
  duration_ms: number;
}

export async function runEdgeQualitySweep(env: Env): Promise<SweepResult> {
  const start = Date.now();
  const rescored = await rescoreAllEdges(env);
  const infl = await rebuildEntityInfluence(env);
  return {
    edges_scored: rescored.scored,
    entities_ranked: infl.ranked,
    sectors_ranked: infl.sectors,
    power_nodes: infl.powerNodes,
    full_pass_wrapped: rescored.wrapped,
    influence_loaded_edges: infl.loadedEdges,
    influence_truncated: infl.truncated,
    duration_ms: Date.now() - start,
  };
}

interface RescoreResult { scored: number; wrapped: boolean; }

async function rescoreAllEdges(env: Env): Promise<RescoreResult> {
  // Resumable cursor: pick up where the previous tick stopped so on
  // graphs larger than EDGE_TICK_CAP the tail doesn't starve. Wraps
  // to '' (start) when no more rows after the cursor; that wrap is
  // recorded as last_full_pass_at so operators can verify freshness
  // (every edge re-scored within ⌈total_edges / EDGE_TICK_CAP⌉ days).
  let cursor = await loadCursor(env);
  let scored = 0;
  let wrapped = false;
  const pages = Math.ceil(EDGE_TICK_CAP / EDGE_BATCH);
  for (let page = 0; page < pages; page++) {
    const r = await env.DB.prepare(
      `SELECT id, src_entity_id, dst_entity_id
         FROM rel_edges
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
    ).bind(cursor, EDGE_BATCH).all<{ id: string; src_entity_id: string; dst_entity_id: string }>();
    let rows = r.results ?? [];
    if (!rows.length) {
      // End of table — wrap to the beginning if we haven't already
      // this tick. If we wrap and still get nothing, the table is
      // empty and we exit.
      if (cursor === "") break;
      cursor = "";
      wrapped = true;
      const r2 = await env.DB.prepare(
        `SELECT id, src_entity_id, dst_entity_id
           FROM rel_edges
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?`,
      ).bind(cursor, EDGE_BATCH).all<{ id: string; src_entity_id: string; dst_entity_id: string }>();
      rows = r2.results ?? [];
      if (!rows.length) break;
    }
    for (const row of rows) {
      try {
        const signals = await collectAllSignals(env, {
          src_entity_id: row.src_entity_id,
          dst_entity_id: row.dst_entity_id,
        });
        const agg = aggregateSignals({ signals });
        await env.DB.prepare(
          `UPDATE rel_edges
              SET quality_score = ?,
                  quality_signals_json = ?,
                  last_interaction_at = ?
            WHERE id = ?`,
        ).bind(
          agg.quality_score,
          JSON.stringify(agg.signals_breakdown),
          agg.last_interaction_at,
          row.id,
        ).run();
        scored += 1;
      } catch (e) {
        console.warn("edge rescore failed", row.id, (e as Error).message);
      }
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < EDGE_BATCH) {
      // End of table reached mid-page → wrap on next tick.
      cursor = "";
      wrapped = true;
      break;
    }
  }
  await persistCursor(env, cursor, scored, wrapped);
  return { scored, wrapped };
}

async function loadCursor(env: Env): Promise<string> {
  try {
    const r = await env.DB.prepare(
      `SELECT cursor FROM edge_quality_state WHERE id = 1`,
    ).first<{ cursor: string }>();
    return r?.cursor ?? "";
  } catch {
    // Migration 368 not applied — fall back to non-resumable behavior.
    return "";
  }
}

async function persistCursor(env: Env, cursor: string, scored: number, wrapped: boolean): Promise<void> {
  try {
    if (wrapped) {
      await env.DB.prepare(
        `UPDATE edge_quality_state
            SET cursor = ?,
                last_full_pass_at = datetime('now'),
                edges_scored_cum = edges_scored_cum + ?,
                updated_at = datetime('now')
          WHERE id = 1`,
      ).bind(cursor, scored).run();
    } else {
      await env.DB.prepare(
        `UPDATE edge_quality_state
            SET cursor = ?,
                edges_scored_cum = edges_scored_cum + ?,
                updated_at = datetime('now')
          WHERE id = 1`,
      ).bind(cursor, scored).run();
    }
  } catch {
    // Migration 368 not applied yet — degrade silently. Next tick
    // will still re-score from the start.
  }
}

interface InfluenceResult {
  ranked: number;
  sectors: number;
  powerNodes: number;
  loadedEdges: number;
  truncated: boolean;
}

async function rebuildEntityInfluence(env: Env): Promise<InfluenceResult> {
  // Load the scored graph in id-ASC chunks (10k/page) up to a hard
  // INFLUENCE_EDGE_CAP ceiling. Global PageRank is not algorithmically
  // chunkable — it needs the full graph in memory — but the streamed
  // load shapes memory growth, and once the cap is hit we stop reading
  // and let computeInfluence() degrade gracefully via its existing
  // nodeCap/edgeCap guardrails (still returns global PR + degrees;
  // skips broker and per-sector PR on oversized graphs).
  const edgeRows: ScoredEdge[] = [];
  let cursor = "";
  let truncated = false;
  const PAGE = 10_000;
  while (edgeRows.length < INFLUENCE_EDGE_CAP) {
    const r = await env.DB.prepare(
      `SELECT id, src_entity_id AS src, dst_entity_id AS dst,
              COALESCE(quality_score, 0.5) AS weight
         FROM rel_edges
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
    ).bind(cursor, PAGE).all<{ id: string; src: string; dst: string; weight: number }>();
    const rows = r.results ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      if (edgeRows.length >= INFLUENCE_EDGE_CAP) { truncated = true; break; }
      edgeRows.push({ src: row.src, dst: row.dst, weight: row.weight });
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < PAGE) break;
  }
  if (truncated) {
    console.warn("entity_influence load truncated at edge cap", INFLUENCE_EDGE_CAP);
  }
  if (edgeRows.length === 0) {
    return { ranked: 0, sectors: 0, powerNodes: 0, loadedEdges: 0, truncated: false };
  }
  const nodeIds = new Set<string>();
  for (const e of edgeRows) { nodeIds.add(e.src); nodeIds.add(e.dst); }
  const primarySector = await loadPrimarySectors(env, Array.from(nodeIds));

  const result = computeInfluence(edgeRows, primarySector);
  if (result.truncated_for_size) {
    console.warn("entity_influence rebuild truncated", result.truncation_reasons.join(","));
  }

  // Prune entity_influence rows for entities no longer in the graph.
  // This keeps the table from accumulating stale rows after edges are
  // deleted or merged.
  try {
    const currentIds = new Set(result.rows.map((r) => r.entity_id));
    const existing = await env.DB.prepare(
      `SELECT entity_id FROM entity_influence`,
    ).all<{ entity_id: string }>();
    const stale = (existing.results ?? [])
      .map((r) => r.entity_id)
      .filter((id) => !currentIds.has(id));
    for (let i = 0; i < stale.length; i += 100) {
      const slice = stale.slice(i, i + 100);
      await env.DB.prepare(
        `DELETE FROM entity_influence WHERE entity_id IN (${slice.map(() => "?").join(",")})`,
      ).bind(...slice).run();
    }
  } catch (e) {
    console.warn("entity_influence prune failed", (e as Error).message);
  }

  let ranked = 0;
  for (const row of result.rows) {
    try {
      await env.DB.prepare(
        `INSERT INTO entity_influence
            (entity_id, pagerank_score, sector_pagerank_json, broker_score,
             in_degree, out_degree, total_degree, is_power_node, primary_sector, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(entity_id) DO UPDATE SET
            pagerank_score = excluded.pagerank_score,
            sector_pagerank_json = excluded.sector_pagerank_json,
            broker_score = excluded.broker_score,
            in_degree = excluded.in_degree,
            out_degree = excluded.out_degree,
            total_degree = excluded.total_degree,
            is_power_node = excluded.is_power_node,
            primary_sector = excluded.primary_sector,
            computed_at = excluded.computed_at`,
      ).bind(
        row.entity_id,
        row.pagerank_score,
        row.sector_pagerank_json,
        row.broker_score,
        row.in_degree,
        row.out_degree,
        row.total_degree,
        row.is_power_node,
        row.primary_sector,
      ).run();
      ranked += 1;
    } catch (e) {
      console.warn("entity_influence upsert failed", row.entity_id, (e as Error).message);
      continue;
    }
    try {
      await insertFact(env, {
        entity_id: row.entity_id,
        predicate: "entity.pagerank_score",
        value_number: round4(row.pagerank_score),
        source_kind: "inferred",
        source: SOURCE,
      });
      await insertFact(env, {
        entity_id: row.entity_id,
        predicate: "entity.broker_score",
        value_number: round4(row.broker_score),
        source_kind: "inferred",
        source: SOURCE,
      });
    } catch (e) {
      console.warn("influence insertFact failed", row.entity_id, (e as Error).message);
    }
  }

  return {
    ranked,
    sectors: result.sectors_ranked,
    powerNodes: result.power_nodes,
    loadedEdges: edgeRows.length,
    truncated: truncated || result.truncated_for_size,
  };
}

/**
 * Best-effort sector lookup, driving the per-sector PageRank partition.
 *
 * This used to read only `entity.primary_sector`, `firm.sector` and
 * `company.sector` from `facts`. No writer in the worker produces any of
 * those three — the plural `firm.sectors` is what the profile workflows emit,
 * `industry` is what the account dual-write emits, and both land as tags that
 * the summary rebuild materialises into `entity_summary.sectors_csv`. So the
 * map came back empty on every sweep, every node fell into the same unsectored
 * bucket, and `sectors_ranked` was 0: per-sector PageRank and the per-sector
 * power-node flags did nothing at all, silently, because an empty map is also
 * what a genuinely unsectored graph produces.
 *
 * `entity_summary.sectors_csv` is now the primary source because it is the
 * materialised one — already deduped, already slugged, one row per entity.
 * The facts lookup stays as a fallback for entities whose summary has not been
 * rebuilt yet, widened to the predicates that are actually written and reading
 * `value_json` too, since the plural forms are stored as JSON arrays.
 */
async function loadPrimarySectors(env: Env, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Chunked IN(...) to avoid hitting D1 bind limits on large graphs.
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    try {
      const r = await env.DB.prepare(
        `SELECT entity_id, sectors_csv
           FROM entity_summary
          WHERE sectors_csv IS NOT NULL AND sectors_csv <> ''
            AND entity_id IN (${slice.map(() => "?").join(",")})`,
      ).bind(...slice).all<{ entity_id: string; sectors_csv: string | null }>();
      for (const row of r.results ?? []) {
        const first = (row.sectors_csv ?? "").split(",").map((x) => x.trim()).find(Boolean);
        if (first && !out.has(row.entity_id)) out.set(row.entity_id, first.toLowerCase());
      }
    } catch (e) {
      await logError(env, {
        err: wrapUnknown(e, "db_error", { chunk_start: i, chunk_size: slice.length }),
        step: "edge_quality.primary_sector_summary",
      });
    }

    const pending = slice.filter((id) => !out.has(id));
    if (!pending.length) continue;
    try {
      const r = await env.DB.prepare(
        `SELECT entity_id, value_text, value_json
           FROM facts
          WHERE is_current = 1
            AND predicate IN ('entity.primary_sector','firm.sector','company.sector',
                              'firm.sectors','company.sectors','sector','industry',
                              'firm.industry')
            AND entity_id IN (${pending.map(() => "?").join(",")})`,
      ).bind(...pending).all<{ entity_id: string; value_text: string | null; value_json: string | null }>();
      for (const row of r.results ?? []) {
        if (out.has(row.entity_id)) continue;
        const v = row.value_text?.trim() || firstOfJsonArray(row.value_json);
        if (v) out.set(row.entity_id, v.toLowerCase());
      }
    } catch (e) {
      console.warn("primary sector lookup chunk failed", (e as Error).message);
    }
  }
  return out;
}

/** First non-empty string in a JSON array column, or null for anything else. */
function firstOfJsonArray(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const x of parsed) {
      if (typeof x === "string" && x.trim()) return x.trim();
    }
  } catch { /* not JSON — nothing to take */ }
  return null;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
