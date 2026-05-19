// Task #3 read endpoints:
//   GET /api/entities/:id/influence
//   GET /api/entities/:id/relationships?min_quality=…
//   GET /api/power-nodes?sector=&persona=
//
// All read-only; sit behind the existing access guard mounted at the
// /api/* root in src/index.ts.

import { Hono } from "hono";
import type { Env } from "../types";

export const influenceRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

// GET /api/entities/:id/influence
influenceRoute.get("/entities/:id/influence", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "bad_request" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT entity_id, pagerank_score, sector_pagerank_json, broker_score,
            in_degree, out_degree, total_degree, is_power_node, primary_sector, computed_at
       FROM entity_influence WHERE entity_id = ?`,
  ).bind(id).first<{
    entity_id: string;
    pagerank_score: number;
    sector_pagerank_json: string | null;
    broker_score: number;
    in_degree: number;
    out_degree: number;
    total_degree: number;
    is_power_node: number;
    primary_sector: string | null;
    computed_at: string;
  }>();
  if (!row) {
    return c.json({
      entity_id: id,
      pagerank_score: null,
      sector_pagerank: {},
      broker_score: null,
      in_degree: 0,
      out_degree: 0,
      total_degree: 0,
      is_power_node: false,
      primary_sector: null,
      computed_at: null,
    });
  }
  let sectorPr: Record<string, number> = {};
  try {
    sectorPr = row.sector_pagerank_json ? JSON.parse(row.sector_pagerank_json) : {};
  } catch {
    sectorPr = {};
  }
  return c.json({
    entity_id: row.entity_id,
    pagerank_score: row.pagerank_score,
    sector_pagerank: sectorPr,
    broker_score: row.broker_score,
    in_degree: row.in_degree,
    out_degree: row.out_degree,
    total_degree: row.total_degree,
    is_power_node: !!row.is_power_node,
    primary_sector: row.primary_sector,
    computed_at: row.computed_at,
  });
});

// GET /api/entities/:id/relationships?min_quality=0.6&limit=100&kind=invested_in
influenceRoute.get("/entities/:id/relationships", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "bad_request" }, 400);
  const minQuality = clamp01(Number(c.req.query("min_quality") ?? "0"));
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? "100")));
  const kindParam = c.req.query("kind");
  const kinds = kindParam ? kindParam.split(",").map((k) => k.trim()).filter(Boolean) : null;

  const kindSql = kinds && kinds.length
    ? ` AND kind IN (${kinds.map(() => "?").join(",")})`
    : "";
  const binds: Array<string | number> = [id, id, minQuality];
  if (kinds && kinds.length) binds.push(...kinds);
  binds.push(limit);

  const r = await c.env.DB.prepare(
    `SELECT id, src_entity_id, dst_entity_id, kind, strength, quality_score,
            quality_signals_json, last_interaction_at, evidence_url, source
       FROM rel_edges
      WHERE (src_entity_id = ? OR dst_entity_id = ?)
        AND COALESCE(quality_score, 0) >= ?
        ${kindSql}
      ORDER BY quality_score DESC NULLS LAST
      LIMIT ?`,
  ).bind(...binds).all<{
    id: string;
    src_entity_id: string;
    dst_entity_id: string;
    kind: string;
    strength: number;
    quality_score: number | null;
    quality_signals_json: string | null;
    last_interaction_at: string | null;
    evidence_url: string | null;
    source: string | null;
  }>();

  const edges = (r.results ?? []).map((row) => ({
    id: row.id,
    src_entity_id: row.src_entity_id,
    dst_entity_id: row.dst_entity_id,
    kind: row.kind,
    strength: row.strength,
    quality_score: row.quality_score,
    quality_signals: safeParse(row.quality_signals_json),
    last_interaction_at: row.last_interaction_at,
    evidence_url: row.evidence_url,
    source: row.source,
  }));
  return c.json({ entity_id: id, min_quality: minQuality, edges });
});

// GET /api/power-nodes?sector=fintech&persona=founder&limit=50
influenceRoute.get("/power-nodes", async (c) => {
  const sector = (c.req.query("sector") ?? "").toLowerCase().trim() || null;
  const persona = (c.req.query("persona") ?? "").toLowerCase().trim() || null;
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? "50")));

  // Sector filter applies on entity_influence.primary_sector; persona
  // filter joins through u_entities.role_default (best-effort — when
  // the column or table is absent, the filter is treated as a no-op
  // and the sweep still returns sector-ranked rows).
  const where: string[] = ["is_power_node = 1"];
  const binds: Array<string | number> = [];
  if (sector) {
    where.push("primary_sector = ?");
    binds.push(sector);
  }
  const sql = `SELECT entity_id, pagerank_score, broker_score, primary_sector,
                      in_degree, out_degree, total_degree
                 FROM entity_influence
                WHERE ${where.join(" AND ")}
                ORDER BY pagerank_score DESC
                LIMIT ?`;
  binds.push(limit);
  const r = await c.env.DB.prepare(sql).bind(...binds).all<{
    entity_id: string;
    pagerank_score: number;
    broker_score: number;
    primary_sector: string | null;
    in_degree: number;
    out_degree: number;
    total_degree: number;
  }>();
  let rows = r.results ?? [];

  // Persona filter — applied post-query to keep the SQL stable when
  // u_entities is in a stub/legacy shape.
  if (persona && rows.length) {
    try {
      const ids = rows.map((row) => row.entity_id);
      const fr = await c.env.DB.prepare(
        `SELECT id, role_default FROM u_entities
          WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).bind(...ids).all<{ id: string; role_default: string | null }>();
      const role = new Map((fr.results ?? []).map((x) => [x.id, (x.role_default ?? "").toLowerCase()]));
      rows = rows.filter((r) => role.get(r.entity_id) === persona);
    } catch {
      // u_entities shape unavailable — fall through with sector-only results.
    }
  }

  return c.json({ sector, persona, count: rows.length, power_nodes: rows });
});

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
