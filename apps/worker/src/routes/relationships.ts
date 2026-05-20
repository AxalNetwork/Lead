// Relationship graph endpoints (Task #21).
// Subgraph BFS, shortest path, co-investors, colleagues, intros.
// `family_of` is filtered everywhere except the lead-detail admin path.

import { Hono } from "hono";
import type { Env } from "../types";
import { runRelationshipDerivation } from "../scraper/relationships/derive";
// Task #4 (Relationship Inference Worker): rel_edges-backed endpoints.
import { runAllExtractors, listExtractors } from "../services/relationships/orchestrator";
import { findPaths, neighborhood, fetchNodeMeta } from "../services/relationships/pathfinder";

export const relationships = new Hono<{ Bindings: Env; Variables: { email: string; is_admin?: boolean } }>();

// ============================================================
// Task #4 (Relationship Inference Worker) endpoints — rel_edges
// (TEXT entity ids). Mounted BEFORE the legacy `/entity/:id` and
// `/path` handlers below so the new query-string contracts
// (`/neighborhood?id=`, `/paths?src=&dst=`) win the route match.
// Per the Task #4 static-routing constraint, all deep links use
// `?id=` query strings, never `/:id` path segments.
// ============================================================

function requireAdmin(c: { var: { is_admin?: boolean; email?: string }; json: (b: unknown, s?: number) => Response }): Response | null {
  // Mirror the inline-admin-check pattern from the dashboards/ops routes
  // (see replit.md Task #14 verification note). c.var.is_admin is
  // populated by the global accessGuard middleware in src/index.ts.
  if (c.var.is_admin) return null;
  const email = (c.var.email ?? "").toLowerCase();
  if (email && email === "guillaumelauzier@gmail.com") return null;
  return c.json({ error: "forbidden" }, 403);
}

// POST /api/relationships/infer-all (admin) — full orchestrator pass.
relationships.post("/infer-all", async (c) => {
  const g = requireAdmin(c as never); if (g) return g;
  const since = c.req.query("since") ?? null;
  const summary = await runAllExtractors(c.env, { since });
  return c.json({ ok: true, extractors: listExtractors(), summary });
});

// POST /api/relationships/infer/:entity_id (admin) — incremental pass.
relationships.post("/infer/:entity_id", async (c) => {
  const g = requireAdmin(c as never); if (g) return g;
  const entityId = c.req.param("entity_id");
  if (!entityId) return c.json({ error: "bad_request" }, 400);
  const summary = await runAllExtractors(c.env, { entityId });
  return c.json({ ok: true, entity_id: entityId, summary });
});

// GET /api/relationships/neighborhood?id=<entity_id>&hops=1
relationships.get("/neighborhood", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "bad_request", reason: "id required" }, 400);
  const hops = Math.min(3, Math.max(1, Number(c.req.query("hops") ?? "1")));
  const limit = Math.min(500, Math.max(10, Number(c.req.query("limit") ?? "150")));
  const sub = await neighborhood(c.env, id, hops, limit);
  // Cytoscape-shaped payload.
  return c.json({
    root_id: id,
    hops,
    nodes: sub.nodes.map((n) => ({ data: { id: n.id, label: n.display_name ?? n.id.slice(0, 8), kind: n.kind } })),
    edges: sub.edges.map((e) => ({
      data: { id: e.id, source: e.src, target: e.dst, kind: e.kind, quality: e.quality },
    })),
  });
});

// GET /api/relationships/paths?src=&dst=&max_hops=4 — up to k shortest paths.
relationships.get("/paths", async (c) => {
  const src = c.req.query("src");
  const dst = c.req.query("dst");
  if (!src || !dst) return c.json({ error: "bad_request", reason: "src and dst required" }, 400);
  const maxHops = Math.min(4, Math.max(1, Number(c.req.query("max_hops") ?? "4")));
  const k = Math.min(10, Math.max(1, Number(c.req.query("k") ?? "5")));
  const paths = await findPaths(c.env, src, dst, maxHops, k);
  const allNodeIds = Array.from(new Set(paths.flatMap((p) => p.nodes)));
  const meta = await fetchNodeMeta(c.env, allNodeIds);
  const nodes = allNodeIds.map((id) => ({
    id, display_name: meta.get(id)?.display_name ?? null, kind: meta.get(id)?.kind ?? null,
  }));
  return c.json({ src, dst, max_hops: maxHops, paths, nodes });
});

interface EntityRow { id: number; kind: string; ref_table: string | null; ref_id: string | null; name: string }
interface EdgeRow { id: number; src: number; dst: number; kind: string; source: string; strength: number; started_at: string | null; ended_at: string | null; evidence_url: string | null }

const ADMIN_EMAILS = new Set(["guillaumelauzier@gmail.com"]);

function isAdmin(email: string | undefined): boolean {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

// Build the kind-filter SQL fragment + binds. By default `family_of` is
// excluded; admin routes can opt-in by passing includeFamily=true.
function kindFilter(kindsParam: string | null, includeFamily: boolean): { sql: string; binds: string[] } {
  const requested = (kindsParam ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length) {
    const allowed = includeFamily ? requested : requested.filter((k) => k !== "family_of");
    if (!allowed.length) return { sql: "0", binds: [] };
    return { sql: "kind IN (" + allowed.map(() => "?").join(",") + ")", binds: allowed };
  }
  return includeFamily ? { sql: "1", binds: [] } : { sql: "kind != 'family_of'", binds: [] };
}

async function fetchEntities(env: Env, ids: number[]): Promise<EntityRow[]> {
  if (!ids.length) return [];
  // D1 binding limit is generous but still chunk to be safe.
  const out: EntityRow[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const r = await env.DB
      .prepare(`SELECT id, kind, ref_table, ref_id, name FROM entities WHERE id IN (${slice.map(() => "?").join(",")})`)
      .bind(...slice).all<EntityRow>();
    out.push(...(r.results ?? []));
  }
  return out;
}

// ---------------------------------------------------------- subgraph BFS
relationships.get("/entity/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const depth = Math.min(2, Math.max(1, Number(c.req.query("depth") ?? "1")));
  const limit = Math.min(500, Math.max(10, Number(c.req.query("limit") ?? "100")));
  const includeFamily = isAdmin(c.get("email")) && c.req.query("include_family") === "1";
  const kf = kindFilter(c.req.query("kinds") ?? null, includeFamily);

  const visited = new Set<number>([id]);
  const seenEdges = new Set<number>();
  const edges: EdgeRow[] = [];
  let frontier: number[] = [id];
  for (let d = 0; d < depth && edges.length < limit; d++) {
    const nextFrontier = new Set<number>();
    for (let i = 0; i < frontier.length; i += 25) {
      const slice = frontier.slice(i, i + 25);
      // Over-fetch then dedupe by edge id; the same edge can appear in
      // multiple chunked queries when its endpoints fall in different
      // frontier slices, and counting duplicates against `limit` would
      // truncate exploration prematurely.
      const r = await c.env.DB
        .prepare(
          `SELECT id, src, dst, kind, source, strength, started_at, ended_at, evidence_url
           FROM relationships
           WHERE (src IN (${slice.map(() => "?").join(",")}) OR dst IN (${slice.map(() => "?").join(",")}))
             AND ${kf.sql}
           LIMIT ?`,
        )
        .bind(...slice, ...slice, ...kf.binds, limit - edges.length).all<EdgeRow>();
      for (const e of r.results ?? []) {
        if (seenEdges.has(e.id)) continue;
        seenEdges.add(e.id);
        edges.push(e);
        if (!visited.has(e.src)) { nextFrontier.add(e.src); visited.add(e.src); }
        if (!visited.has(e.dst)) { nextFrontier.add(e.dst); visited.add(e.dst); }
        if (edges.length >= limit) break;
      }
      if (edges.length >= limit) break;
    }
    frontier = Array.from(nextFrontier);
    if (!frontier.length) break;
  }
  const nodes = await fetchEntities(c.env, Array.from(visited));
  return c.json({ nodes, edges });
});

async function shortestPath(env: Env, src: number, dst: number, maxHops: number, kf: { sql: string; binds: string[] }): Promise<{ nodes: EntityRow[]; edges: EdgeRow[]; hops: number }> {
  if (src === dst) {
    const nodes = await fetchEntities(env, [src]);
    return { nodes, edges: [], hops: 0 };
  }
  // Two parent maps — one rooted at src, one at dst. When BFS from one
  // direction encounters a node already known to the other side, we have a
  // path; reconstruct by walking each parent map back to its root.
  const fParent = new Map<number, { from: number; edge: EdgeRow }>();
  const bParent = new Map<number, { from: number; edge: EdgeRow }>();
  let fFront = new Set<number>([src]);
  let bFront = new Set<number>([dst]);
  const fSeen = new Set<number>([src]);
  const bSeen = new Set<number>([dst]);

  async function neighbors(ids: number[]): Promise<EdgeRow[]> {
    const out: EdgeRow[] = [];
    for (let i = 0; i < ids.length; i += 25) {
      const slice = ids.slice(i, i + 25);
      const r = await env.DB
        .prepare(
          `SELECT id, src, dst, kind, source, strength, started_at, ended_at, evidence_url
           FROM relationships
           WHERE (src IN (${slice.map(() => "?").join(",")}) OR dst IN (${slice.map(() => "?").join(",")}))
             AND ${kf.sql}`,
        )
        .bind(...slice, ...slice, ...kf.binds).all<EdgeRow>();
      out.push(...(r.results ?? []));
    }
    return out;
  }

  let meet: number | null = null;
  for (let hop = 0; hop < maxHops && meet == null; hop++) {
    // Expand the smaller frontier on each round to keep the search balanced.
    const expandForward = fFront.size <= bFront.size;
    const front = expandForward ? fFront : bFront;
    const seen = expandForward ? fSeen : bSeen;
    const otherSeen = expandForward ? bSeen : fSeen;
    const parentMap = expandForward ? fParent : bParent;
    const edgesBatch = await neighbors(Array.from(front));
    const next = new Set<number>();
    for (const e of edgesBatch) {
      const fromId = front.has(e.src) ? e.src : (front.has(e.dst) ? e.dst : null);
      if (fromId == null) continue;
      const toId = fromId === e.src ? e.dst : e.src;
      if (seen.has(toId)) continue;
      seen.add(toId);
      parentMap.set(toId, { from: fromId, edge: e });
      next.add(toId);
      if (otherSeen.has(toId)) { meet = toId; break; }
    }
    if (expandForward) fFront = next; else bFront = next;
    if (!next.size) break;
  }
  if (meet == null) return { nodes: [], edges: [], hops: -1 };

  // src ← … ← meet via fParent.
  const fwdEdges: EdgeRow[] = []; const fwdNodes: number[] = [meet];
  let cur = meet;
  while (cur !== src) {
    const p = fParent.get(cur); if (!p) break;
    fwdEdges.push(p.edge); fwdNodes.push(p.from); cur = p.from;
  }
  fwdNodes.reverse(); fwdEdges.reverse();
  // meet → … → dst via bParent.
  const backEdges: EdgeRow[] = []; const backNodes: number[] = [];
  cur = meet;
  while (cur !== dst) {
    const p = bParent.get(cur); if (!p) break;
    backEdges.push(p.edge); backNodes.push(p.from); cur = p.from;
  }
  const allIds: number[] = fwdNodes.concat(backNodes);
  const allEdges = fwdEdges.concat(backEdges);
  const nodes = await fetchEntities(env, allIds);
  // Order nodes to match the path order.
  const nodeIx = new Map(nodes.map((n) => [n.id, n]));
  const orderedNodes = allIds.map((id) => nodeIx.get(id)).filter((n): n is EntityRow => !!n);
  return { nodes: orderedNodes, edges: allEdges, hops: allEdges.length };
}

// ---------------------------------------------------------- shortest path
relationships.get("/path", async (c) => {
  const src = Number(c.req.query("src"));
  const dst = Number(c.req.query("dst"));
  const maxHops = Math.min(6, Math.max(1, Number(c.req.query("max_hops") ?? "4")));
  if (!Number.isFinite(src) || !Number.isFinite(dst)) return c.json({ error: "bad_request" }, 400);
  // family_of is excluded by default on every endpoint and only honoured
  // when the caller is admin AND explicitly opts in via include_family=1.
  const includeFamily = isAdmin(c.get("email")) && c.req.query("include_family") === "1";
  const kf = kindFilter(c.req.query("kinds") ?? null, includeFamily);
  return c.json(await shortestPath(c.env, src, dst, maxHops, kf));
});

// ---------------------------------------------------------- co-investors
relationships.get("/coinvestors/:firmId", async (c) => {
  const firmId = Number(c.req.param("firmId"));
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const limit = Math.min(100, Math.max(5, Number(c.req.query("limit") ?? "25")));
  // Resolve firm row id → entity id.
  const ent = await c.env.DB
    .prepare("SELECT id FROM entities WHERE ref_table = 'firms' AND ref_id = ?")
    .bind(String(firmId)).first<{ id: number }>();
  if (!ent) return c.json({ items: [] });
  const r = await c.env.DB
    .prepare(
      `SELECT e.id AS entity_id, e.name, e.ref_id AS firm_id, COUNT(*) AS overlap
       FROM relationships r
       JOIN entities e ON e.id = r.dst
       WHERE r.src = ? AND r.kind = 'co_invested_with'
       GROUP BY r.dst
       ORDER BY overlap DESC LIMIT ?`,
    )
    .bind(ent.id, limit).all<{ entity_id: number; name: string; firm_id: string; overlap: number }>();
  return c.json({ items: r.results ?? [] });
});

// ---------------------------------------------------------- colleagues
relationships.get("/colleagues/:leadId", async (c) => {
  const leadId = c.req.param("leadId");
  const limit = Math.min(100, Math.max(5, Number(c.req.query("limit") ?? "25")));
  const ent = await c.env.DB
    .prepare("SELECT id FROM entities WHERE ref_table = 'leads' AND ref_id = ?")
    .bind(leadId).first<{ id: number }>();
  if (!ent) return c.json({ items: [] });
  const r = await c.env.DB
    .prepare(
      `SELECT e.id AS entity_id, e.name, e.ref_id AS lead_id, COUNT(*) AS shared_firms
       FROM relationships r
       JOIN entities e ON e.id = r.dst
       WHERE r.src = ? AND r.kind = 'colleague_of'
       GROUP BY r.dst
       ORDER BY shared_firms DESC LIMIT ?`,
    )
    .bind(ent.id, limit).all<{ entity_id: number; name: string; lead_id: string; shared_firms: number }>();
  return c.json({ items: r.results ?? [] });
});

// ---------------------------------------------------------- intros
// Resolves `to` from any of: numeric entity id, lead UUID, firm row id.
// Resolves `from` (the caller) by preferring an existing lead with the same
// email — that gives the intro path access to the full professional graph
// (works_at / school_with / colleague_of). If no such lead exists we fall
// back to a minted `users` entity, which will only have edges added later
// (e.g. via a `referred` row) but at least keeps the call non-fatal.
relationships.get("/intros", async (c) => {
  const callerEmail = c.get("email");
  const toRaw = c.req.query("to") ?? "";
  if (!toRaw) return c.json({ error: "bad_request" }, 400);

  // `to_kind` disambiguates numeric inputs that could refer to either an
  // `entities.id` or a `firms.id`. Allowed values: "entity" (default for
  // numeric input), "firm", "lead". Without an explicit kind, a numeric
  // value with collisions in both spaces returns 400 so the caller picks.
  const toKind = (c.req.query("to_kind") ?? "").toLowerCase();
  async function resolveTarget(raw: string): Promise<{ id: number } | { error: string; status: 400 | 404; detail?: unknown }> {
    if (toKind === "lead") {
      const l = await c.env.DB.prepare("SELECT id FROM entities WHERE ref_table='leads' AND ref_id=?").bind(raw).first<{ id: number }>();
      return l ? { id: l.id } : { error: "lead_not_found", status: 404 };
    }
    if (toKind === "firm") {
      const f = await c.env.DB.prepare("SELECT id FROM entities WHERE ref_table='firms' AND ref_id=?").bind(raw).first<{ id: number }>();
      return f ? { id: f.id } : { error: "firm_not_found", status: 404 };
    }
    if (toKind === "entity") {
      const e = await c.env.DB.prepare("SELECT id FROM entities WHERE id=?").bind(Number(raw)).first<{ id: number }>();
      return e ? { id: e.id } : { error: "entity_not_found", status: 404 };
    }
    const num = Number(raw);
    if (Number.isFinite(num) && raw.match(/^-?\d+$/)) {
      // Both lookups in parallel so we can spot collisions.
      const [ent, firm] = await Promise.all([
        c.env.DB.prepare("SELECT id FROM entities WHERE id=?").bind(num).first<{ id: number }>(),
        c.env.DB.prepare("SELECT id FROM entities WHERE ref_table='firms' AND ref_id=?").bind(String(num)).first<{ id: number }>(),
      ]);
      if (ent && firm && ent.id !== firm.id) {
        return { error: "ambiguous_target", status: 400, detail: { entity_id: ent.id, firm_entity_id: firm.id, hint: "pass &to_kind=entity or &to_kind=firm" } };
      }
      if (ent) return { id: ent.id };
      if (firm) return { id: firm.id };
      return { error: "target_not_found", status: 404 };
    }
    // Non-numeric → treat as a lead UUID.
    const l = await c.env.DB.prepare("SELECT id FROM entities WHERE ref_table='leads' AND ref_id=?").bind(raw).first<{ id: number }>();
    return l ? { id: l.id } : { error: "target_not_found", status: 404 };
  }
  const resolved = await resolveTarget(toRaw);
  if ("error" in resolved) return c.json({ error: resolved.error, ...(resolved.detail ? { detail: resolved.detail } : {}) }, resolved.status);
  const to = resolved.id;

  // Resolve caller "from" entity.
  let from: number | null = null;
  const callerLead = await c.env.DB
    .prepare("SELECT id FROM leads WHERE LOWER(email) = LOWER(?) AND merged_into IS NULL LIMIT 1")
    .bind(callerEmail).first<{ id: string }>();
  if (callerLead) {
    const ent = await c.env.DB.prepare("SELECT id FROM entities WHERE ref_table='leads' AND ref_id=?").bind(callerLead.id).first<{ id: number }>();
    if (ent) from = ent.id;
  }
  if (from == null) {
    let me = await c.env.DB
      .prepare("SELECT id FROM entities WHERE ref_table='users' AND ref_id=?")
      .bind(callerEmail).first<{ id: number }>();
    if (!me) {
      const ins = await c.env.DB
        .prepare("INSERT INTO entities (kind, ref_table, ref_id, name) VALUES ('user','users',?,?)")
        .bind(callerEmail, callerEmail).run();
      me = { id: ins.meta.last_row_id as number };
    }
    from = me.id;
  }

  // Constrain to edge kinds that make sense as intro paths. /intros never
  // surfaces family_of, regardless of admin status, since this endpoint
  // exists to suggest professional connections.
  // Spec: intro paths use exactly works_at | partner_at | school_with | referred.
  const kf = kindFilter("works_at,partner_at,school_with,referred", false);
  const path = await shortestPath(c.env, from, to, 4, kf);
  // Surface intermediate contact channels: pull email/linkedin for each
  // person/firm in the path so the UI can show how to reach out.
  const channels: Record<number, { email?: string; linkedin?: string; website?: string }> = {};
  for (const n of path.nodes) {
    if (n.ref_table === "leads" && n.ref_id) {
      const r = await c.env.DB.prepare("SELECT email, linkedin_url FROM leads WHERE id = ?").bind(n.ref_id).first<{ email: string | null; linkedin_url: string | null }>();
      if (r) channels[n.id] = { email: r.email ?? undefined, linkedin: r.linkedin_url ?? undefined };
    } else if (n.ref_table === "firms" && n.ref_id) {
      const r = await c.env.DB.prepare("SELECT website, contact_email FROM firms WHERE id = ?").bind(Number(n.ref_id)).first<{ website: string | null; contact_email: string | null }>();
      if (r) channels[n.id] = { email: r.contact_email ?? undefined, website: r.website ?? undefined };
    }
  }
  return c.json({ ...path, channels });
});

// ---------------------------------------------------------- intro candidates
// "Top 5 people two hops away from a target lead." For each candidate person,
// we count the distinct intermediaries that link them to the target via
// professional kinds (works_at/partner_at/school_with/colleague_of/
// co_invested_with). Excludes the target itself, direct (1-hop) neighbors,
// and family_of by default.
relationships.get("/intros/candidates", async (c) => {
  const toRaw = (c.req.query("to") ?? "").trim();
  const limit = Math.min(20, Math.max(1, Number(c.req.query("limit") ?? "5")));
  if (!toRaw) return c.json({ error: "bad_request" }, 400);
  // Resolve target to an entity id (lead UUID or numeric entity id).
  let targetEnt: number | null = null;
  if (/^-?\d+$/.test(toRaw)) {
    const e = await c.env.DB.prepare("SELECT id FROM entities WHERE id=?").bind(Number(toRaw)).first<{ id: number }>();
    if (e) targetEnt = e.id;
  }
  if (targetEnt == null) {
    const l = await c.env.DB.prepare("SELECT id FROM entities WHERE ref_table='leads' AND ref_id=?").bind(toRaw).first<{ id: number }>();
    if (l) targetEnt = l.id;
  }
  if (targetEnt == null) return c.json({ error: "target_not_found" }, 404);
  const PRO = "('works_at','partner_at','school_with','colleague_of','co_invested_with','referred')";
  const r = await c.env.DB.prepare(
    `WITH neigh AS (
       SELECT CASE WHEN src = ?1 THEN dst ELSE src END AS via
       FROM relationships
       WHERE (src = ?1 OR dst = ?1) AND kind IN ${PRO}
     )
     SELECT e.id AS entity_id, e.name, e.ref_table, e.ref_id,
            COUNT(DISTINCT n.via) AS via_count,
            GROUP_CONCAT(DISTINCT ve.name) AS via_names
     FROM relationships r2
     JOIN neigh n ON (r2.src = n.via OR r2.dst = n.via)
     JOIN entities e ON e.id = CASE WHEN r2.src = n.via THEN r2.dst ELSE r2.src END
     LEFT JOIN entities ve ON ve.id = n.via
     WHERE e.kind = 'person'
       AND e.id != ?1
       AND e.id NOT IN (SELECT via FROM neigh)
       AND r2.kind IN ${PRO}
     GROUP BY e.id
     ORDER BY via_count DESC, e.name ASC
     LIMIT ?2`,
  ).bind(targetEnt, limit).all<{ entity_id: number; name: string; ref_table: string; ref_id: string; via_count: number; via_names: string }>();
  return c.json({ items: r.results ?? [] });
});

// ---------------------------------------------------------- entity search
relationships.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "20")));
  if (q.length < 2) return c.json({ items: [] });
  const r = await c.env.DB
    .prepare("SELECT id, kind, ref_table, ref_id, name FROM entities WHERE name LIKE ? ORDER BY length(name) ASC LIMIT ?")
    .bind(`%${q}%`, limit).all<EntityRow>();
  return c.json({ items: r.results ?? [] });
});

// ---------------------------------------------------------- run derivation
// Manual trigger for ops; the nightly cron calls runRelationshipDerivation
// directly from the scheduled handler.
relationships.post("/derive", async (c) => {
  if (!isAdmin(c.get("email"))) return c.json({ error: "forbidden" }, 403);
  const r = await runRelationshipDerivation(c.env);
  return c.json(r);
});
