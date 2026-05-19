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
import { pagerank, type PRNode, type PREdge } from "./pagerank";
import { brokerScores } from "./broker";
import { insertFact } from "../../entities/facts";

const EDGE_BATCH = 200;        // edges scored per loop iteration
const POWER_TOP_N = 50;        // per-sector top-N flagged is_power_node
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
  // we'll chunk by SCC.
  const edges = await env.DB.prepare(
    `SELECT src_entity_id AS src, dst_entity_id AS dst,
            COALESCE(quality_score, 0.5) AS weight
       FROM rel_edges`,
  ).all<{ src: string; dst: string; weight: number }>();
  const edgeRows = edges.results ?? [];
  const nodeSet = new Set<string>();
  for (const e of edgeRows) {
    nodeSet.add(e.src);
    nodeSet.add(e.dst);
  }
  if (nodeSet.size === 0) {
    return { ranked: 0, sectors: 0, powerNodes: 0 };
  }
  const nodes: PRNode[] = Array.from(nodeSet).map((id) => ({ id }));
  const prEdges: PREdge[] = edgeRows.map((e) => ({ src: e.src, dst: e.dst, weight: e.weight }));
  const global = pagerank(nodes, prEdges);

  // Per-entity in/out degree (count, not weight).
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edgeRows) {
    outDeg.set(e.src, (outDeg.get(e.src) ?? 0) + 1);
    inDeg.set(e.dst, (inDeg.get(e.dst) ?? 0) + 1);
  }

  // Broker score on the undirected symmetrized graph.
  const undirected = new Map<string, Map<string, number>>();
  for (const e of edgeRows) {
    if (!undirected.has(e.src)) undirected.set(e.src, new Map());
    if (!undirected.has(e.dst)) undirected.set(e.dst, new Map());
    const a = undirected.get(e.src)!;
    const b = undirected.get(e.dst)!;
    a.set(e.dst, Math.max(a.get(e.dst) ?? 0, e.weight));
    b.set(e.src, Math.max(b.get(e.src) ?? 0, e.weight));
  }
  const broker = brokerScores({ adjacency: undirected });

  // Primary sector per entity (best-effort from facts).
  const primarySector = await loadPrimarySectors(env, nodes.map((n) => n.id));

  // Per-sector PageRank — partition entities by primary_sector, then
  // PR-rank within each induced subgraph.
  const sectorBuckets = new Map<string, string[]>();
  for (const id of nodeSet) {
    const s = primarySector.get(id);
    if (!s) continue;
    if (!sectorBuckets.has(s)) sectorBuckets.set(s, []);
    sectorBuckets.get(s)!.push(id);
  }
  const sectorScores = new Map<string, Map<string, number>>(); // entity_id → sector → score
  for (const [sector, ids] of sectorBuckets) {
    if (ids.length < 2) continue;
    const idSet = new Set(ids);
    const sectorEdges = prEdges.filter((e) => idSet.has(e.src) && idSet.has(e.dst));
    if (!sectorEdges.length) continue;
    const sub = pagerank(
      ids.map((id) => ({ id })),
      sectorEdges,
    );
    for (const [id, sc] of sub.scores) {
      if (!sectorScores.has(id)) sectorScores.set(id, new Map());
      sectorScores.get(id)!.set(sector, sc);
    }
  }

  // Power-node detection — top-N per sector by sector-PageRank.
  const powerSet = new Set<string>();
  for (const [, ids] of sectorBuckets) {
    const ranked = ids
      .map((id) => ({ id, score: sectorScores.get(id)?.get(primarySector.get(id) ?? "") ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, POWER_TOP_N);
    for (const r of ranked) powerSet.add(r.id);
  }

  // Persist entity_influence + mirror facts.
  let ranked = 0;
  for (const id of nodeSet) {
    const pr = global.scores.get(id) ?? 0;
    const br = broker.get(id) ?? 0;
    const sectorJson = sectorScores.has(id)
      ? JSON.stringify(Object.fromEntries(sectorScores.get(id)!))
      : null;
    const sector = primarySector.get(id) ?? null;
    const isPower = powerSet.has(id) ? 1 : 0;
    const inD = inDeg.get(id) ?? 0;
    const outD = outDeg.get(id) ?? 0;
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
      ).bind(id, pr, sectorJson, br, inD, outD, inD + outD, isPower, sector).run();
      ranked += 1;
    } catch (e) {
      console.warn("entity_influence upsert failed", id, (e as Error).message);
      continue;
    }
    // Mirror facts via canonical write path.
    try {
      await insertFact(env, {
        entity_id: id,
        predicate: "entity.pagerank_score",
        value_number: round4(pr),
        source_kind: "inferred",
        source: SOURCE,
      });
      await insertFact(env, {
        entity_id: id,
        predicate: "entity.broker_score",
        value_number: round4(br),
        source_kind: "inferred",
        source: SOURCE,
      });
    } catch (e) {
      console.warn("influence insertFact failed", id, (e as Error).message);
    }
  }

  return { ranked, sectors: sectorBuckets.size, powerNodes: powerSet.size };
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
