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

  const rawEdges = r.results ?? [];

  // Best-effort enrich each edge with the neighbor's display_name —
  // the UI uses neighbor_name in its sidebar and for fallback name-
  // matching. When u_entities is unavailable (test DBs / stubs) we
  // ship the edges without names; the UI keys overlays off
  // neighbor_id which is always present.
  const neighborIds = Array.from(new Set(rawEdges.map((e) => (e.src_entity_id === id ? e.dst_entity_id : e.src_entity_id))));
  const nameById = new Map<string, string>();
  if (neighborIds.length) {
    try {
      for (let i = 0; i < neighborIds.length; i += 100) {
        const slice = neighborIds.slice(i, i + 100);
        const nr = await c.env.DB.prepare(
          `SELECT id, display_name FROM u_entities WHERE id IN (${slice.map(() => "?").join(",")})`,
        ).bind(...slice).all<{ id: string; display_name: string | null }>();
        for (const row of nr.results ?? []) {
          if (row.display_name) nameById.set(row.id, row.display_name);
        }
      }
    } catch {
      // u_entities shape unavailable — neighbor_name remains null.
    }
  }

  const edges = rawEdges.map((row) => {
    const neighborId = row.src_entity_id === id ? row.dst_entity_id : row.src_entity_id;
    return {
      id: row.id,
      src_entity_id: row.src_entity_id,
      dst_entity_id: row.dst_entity_id,
      neighbor_id: neighborId,
      neighbor_name: nameById.get(neighborId) ?? null,
      kind: row.kind,
      strength: row.strength,
      quality_score: row.quality_score,
      quality_signals: safeParse(row.quality_signals_json),
      last_interaction_at: row.last_interaction_at,
      evidence_url: row.evidence_url,
      source: row.source,
    };
  });
  return c.json({ entity_id: id, min_quality: minQuality, edges });
});

// GET /api/power-nodes?sector=fintech&persona=founder&limit=50
//
// JOINs u_entities so display_name is returned alongside the score
// columns (UI uses display_name for badges). Persona filter is
// applied in SQL BEFORE the LIMIT so the returned set is the true
// top-N for the requested slice. If u_entities isn't available
// (test DBs / stubs) we fall back to a no-join query which omits
// display_name and the persona filter — operators can see the data
// either way, just without the persona slice.
influenceRoute.get("/power-nodes", async (c) => {
  const sector = (c.req.query("sector") ?? "").toLowerCase().trim() || null;
  const persona = (c.req.query("persona") ?? "").toLowerCase().trim() || null;
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? "50")));

  const joined = `
    SELECT i.entity_id, i.pagerank_score, i.broker_score, i.primary_sector,
           i.in_degree, i.out_degree, i.total_degree,
           u.display_name, u.role_default
      FROM entity_influence i
      LEFT JOIN u_entities u ON u.id = i.entity_id
     WHERE i.is_power_node = 1`;
  const conds: string[] = [];
  const binds: Array<string | number> = [];
  if (sector) { conds.push("i.primary_sector = ?"); binds.push(sector); }
  if (persona) { conds.push("LOWER(COALESCE(u.role_default,'')) = ?"); binds.push(persona); }
  const tail = `${conds.length ? " AND " + conds.join(" AND ") : ""}
                ORDER BY i.pagerank_score DESC
                LIMIT ?`;
  binds.push(limit);
  let rows: Array<{
    entity_id: string;
    pagerank_score: number;
    broker_score: number;
    primary_sector: string | null;
    in_degree: number;
    out_degree: number;
    total_degree: number;
    display_name: string | null;
    role_default: string | null;
  }> = [];
  try {
    const r = await c.env.DB.prepare(joined + tail).bind(...binds).all<typeof rows[number]>();
    rows = r.results ?? [];
  } catch {
    // Fallback: u_entities absent or in a stub shape. Persona filter
    // cannot be honored without it; sector-only results still ship.
    const where: string[] = ["is_power_node = 1"];
    const bindsLite: Array<string | number> = [];
    if (sector) { where.push("primary_sector = ?"); bindsLite.push(sector); }
    bindsLite.push(limit);
    const r = await c.env.DB.prepare(
      `SELECT entity_id, pagerank_score, broker_score, primary_sector,
              in_degree, out_degree, total_degree,
              NULL AS display_name, NULL AS role_default
         FROM entity_influence
        WHERE ${where.join(" AND ")}
        ORDER BY pagerank_score DESC
        LIMIT ?`,
    ).bind(...bindsLite).all<typeof rows[number]>();
    rows = r.results ?? [];
  }

  return c.json({ sector, persona, count: rows.length, power_nodes: rows });
});

// POST /api/entities/resolve
//
// Bulk-resolves legacy (ref_table, ref_id) pairs to unified entity
// ids so the relationship-graph UI can overlay influence/quality
// data without forcing every callsite (lead.js, firm-detail.js,
// relationships.js) to know about unified ids. Returns a map keyed
// by `${ref_table}:${ref_id}` → unified_entity_id (or null when no
// matching u_entities row exists).
influenceRoute.post("/entities/resolve", async (c) => {
  let body: { refs?: Array<{ ref_table?: string; ref_id?: string | number }> };
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const refs = (body.refs ?? []).filter((r) => r && r.ref_table && r.ref_id != null).slice(0, 500);
  const out: Record<string, string | null> = {};
  if (!refs.length) return c.json({ map: out });
  try {
    // Chunked IN to stay under D1 bind limits.
    for (let i = 0; i < refs.length; i += 100) {
      const slice = refs.slice(i, i + 100);
      // Build a UNION ALL because (ref_table, ref_id) is a composite
      // and SQLite IN-tuples aren't reliably supported.
      const sql = slice
        .map(() => `SELECT ? AS ref_table, ? AS ref_id`)
        .join(" UNION ALL ");
      const binds: Array<string | number> = [];
      for (const r of slice) {
        binds.push(String(r.ref_table));
        binds.push(String(r.ref_id));
      }
      const r = await c.env.DB.prepare(
        `WITH wanted(ref_table, ref_id) AS (${sql})
         SELECT w.ref_table, w.ref_id, u.id
           FROM wanted w
           LEFT JOIN u_entities u
             ON u.ref_table = w.ref_table AND u.ref_id = w.ref_id`,
      ).bind(...binds).all<{ ref_table: string; ref_id: string; id: string | null }>();
      for (const row of r.results ?? []) {
        out[`${row.ref_table}:${row.ref_id}`] = row.id ?? null;
      }
    }
  } catch {
    // u_entities not in expected shape — return whatever we have
    // (likely empty). UI degrades to legacy rendering.
  }
  return c.json({ map: out });
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
