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

const EDGE_BATCH = 200;        // edges scored per loop iteration
const SOURCE = "edge_quality_engine";

export interface SweepResult {
  edges_scored: number;
  entities_ranked: number;
  sectors_ranked: number;
  power_nodes: number;
  duration_ms: number;
}

export async function runEdgeQualitySweep(env: Env): Promise<SweepResult> {
  const start = Date.now();
  const edgesScored = await rescoreAllEdges(env);
  const { ranked, sectors, powerNodes } = await rebuildEntityInfluence(env);
  return {
    edges_scored: edgesScored,
    entities_ranked: ranked,
    sectors_ranked: sectors,
    power_nodes: powerNodes,
    duration_ms: Date.now() - start,
  };
}

async function rescoreAllEdges(env: Env): Promise<number> {
  let cursor = "";
  let scored = 0;
  // Iterate by id ASC; bounded so a single tick doesn't blow the CPU
  // budget. The 5000 hard ceiling matches the Task #2 fund-sweep
  // precedent.
  for (let page = 0; page < 25; page++) {
    const r = await env.DB.prepare(
      `SELECT id, src_entity_id, dst_entity_id
         FROM rel_edges
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
    ).bind(cursor, EDGE_BATCH).all<{ id: string; src_entity_id: string; dst_entity_id: string }>();
    const rows = r.results ?? [];
    if (!rows.length) break;
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
    if (rows.length < EDGE_BATCH) break;
  }
  return scored;
}

interface InfluenceResult {
  ranked: number;
  sectors: number;
  powerNodes: number;
}

async function rebuildEntityInfluence(env: Env): Promise<InfluenceResult> {
  // Load full scored graph. For the present platform population this
  // fits comfortably in Worker memory; if it grows past fit-in-memory
  // computeInfluence() degrades gracefully via its nodeCap/edgeCap
  // guardrails (still returns global PageRank + degrees; skips broker
  // and per-sector PR on graphs > 20k nodes / 200k edges).
  const edges = await env.DB.prepare(
    `SELECT src_entity_id AS src, dst_entity_id AS dst,
            COALESCE(quality_score, 0.5) AS weight
       FROM rel_edges`,
  ).all<{ src: string; dst: string; weight: number }>();
  const edgeRows: ScoredEdge[] = (edges.results ?? []) as ScoredEdge[];
  if (edgeRows.length === 0) {
    return { ranked: 0, sectors: 0, powerNodes: 0 };
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

  return { ranked, sectors: result.sectors_ranked, powerNodes: result.power_nodes };
}

/**
 * Best-effort sector lookup. Reads the most recent fact with predicate
 * `entity.primary_sector` for each id; falls back to `firm.sector` for
 * firm entities and `company.sector` for company entities. Empty for
 * ids with no sector evidence.
 */
async function loadPrimarySectors(env: Env, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Chunked IN(...) to avoid hitting D1 bind limits on large graphs.
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    try {
      const r = await env.DB.prepare(
        `SELECT entity_id, value_text
           FROM facts
          WHERE is_current = 1
            AND predicate IN ('entity.primary_sector','firm.sector','company.sector')
            AND entity_id IN (${slice.map(() => "?").join(",")})`,
      ).bind(...slice).all<{ entity_id: string; value_text: string | null }>();
      for (const row of r.results ?? []) {
        if (row.value_text && !out.has(row.entity_id)) {
          out.set(row.entity_id, row.value_text.toLowerCase());
        }
      }
    } catch (e) {
      console.warn("primary sector lookup chunk failed", (e as Error).message);
    }
  }
  return out;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
