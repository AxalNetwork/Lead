// Task #2: link discovery API.
//
// All routes are admin-only — they require the same Cloudflare Access
// gate the rest of `/api` uses. The seed route can run synchronously
// for small jobs or dispatch a `DiscoverFromSeedWorkflow` for durable
// execution; both are exposed.

import { Hono } from "hono";
import type { Env } from "../types";
import { runDiscoverFromSeed, runCrawlFrontier, ALL_METHOD_NAMES } from "../discovery/runDiscovery";
import { canonicalizeUrl } from "../discovery/canonical";

// Methods that actually return links today (the other 10 are reserved
// names exposed for forward-compatibility). Validating against this set
// prevents callers from silently running zero-method discovery jobs.
const IMPLEMENTED_METHODS = new Set([
  "outbound", "sitemap", "rss_atom", "opengraph_meta", "jsonld_sameas",
  "archive_wayback", "sister_pages", "citations",
]);

async function runExists(env: Env, runId: string): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT 1 AS x FROM discovery_runs WHERE id = ?`).bind(runId).first<{ x: number }>();
  return !!r;
}

export const discoveryRoute = new Hono<{ Bindings: Env }>();

discoveryRoute.get("/methods", (c) => c.json({ methods: ALL_METHOD_NAMES }));

discoveryRoute.post("/seed", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    url?: string; depth?: number; max_per_host?: number; methods?: string[]; dispatch?: boolean; yield_threshold?: number;
  };
  if (!body.url) return c.json({ error: "url_required" }, 400);
  // Strict scheme gate: only http/https URLs make sense as discovery
  // seeds. `canonicalizeUrl` happily accepts `mailto:` / `tel:` etc.
  // and returns scheme="other", which would otherwise create noisy
  // runs that the methods could never crawl.
  const rawScheme = (body.url.match(/^([a-z][a-z0-9+.\-]*):/i)?.[1] ?? "").toLowerCase();
  if (rawScheme && rawScheme !== "http" && rawScheme !== "https") {
    return c.json({ error: "unsupported_scheme", scheme: rawScheme }, 400);
  }
  const can = canonicalizeUrl(body.url);
  if (!can) return c.json({ error: "invalid_url" }, 400);
  if (can.scheme && can.scheme !== "http" && can.scheme !== "https") {
    return c.json({ error: "unsupported_scheme", scheme: can.scheme }, 400);
  }
  // Reject when the caller asked for methods that are all unimplemented —
  // otherwise the run would silently produce zero links and look broken.
  // Returns the dropped names so operators see exactly what we ignored.
  let ignored_methods: string[] = [];
  let effective_methods: string[] | undefined;
  if (body.methods && body.methods.length > 0) {
    const live = body.methods.filter((m) => IMPLEMENTED_METHODS.has(m));
    ignored_methods = body.methods.filter((m) => !IMPLEMENTED_METHODS.has(m));
    if (live.length === 0) {
      return c.json({ error: "no_implemented_methods", implemented: [...IMPLEMENTED_METHODS], ignored_methods }, 400);
    }
    body.methods = live;
    effective_methods = live;
  }

  if (body.dispatch && c.env.WF_DISCOVER_FROM_SEED) {
    const wf = await c.env.WF_DISCOVER_FROM_SEED.create({ params: { url: can.url, depthMax: body.depth ?? 3, maxPerHost: body.max_per_host ?? 200, methods: body.methods, yieldThreshold: body.yield_threshold } });
    return c.json({ ok: true, dispatched: true, workflow_id: wf.id, ignored_methods, effective_methods });
  }

  const r = await runDiscoverFromSeed(c.env, {
    url: can.url,
    depthMax: body.depth ?? 3,
    maxPerHost: body.max_per_host ?? 200,
    methods: body.methods,
    yieldThreshold: body.yield_threshold,
  });
  return c.json({ ok: true, ...r, ignored_methods, effective_methods });
});

discoveryRoute.post("/crawl", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { run_id?: string; limit?: number };
  if (body.run_id && !(await runExists(c.env, body.run_id))) {
    return c.json({ error: "unknown_run_id" }, 400);
  }
  if (body.run_id && c.env.WF_CRAWL_FRONTIER) {
    const wf = await c.env.WF_CRAWL_FRONTIER.create({ params: { runId: body.run_id, limit: body.limit ?? 25 } });
    return c.json({ ok: true, dispatched: true, workflow_id: wf.id });
  }
  const r = await runCrawlFrontier(c.env, { runId: body.run_id, limit: body.limit ?? 25 });
  return c.json({ ok: true, ...r });
});

discoveryRoute.get("/urls", async (c) => {
  const status = c.req.query("status");
  const host = c.req.query("host");
  const method = c.req.query("method");
  const minYield = Number(c.req.query("min_yield") ?? "0") || 0;
  const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 500);
  const offset = Math.max(Number(c.req.query("offset") ?? "0") || 0, 0);
  const wheres: string[] = ["expected_yield_score >= ?"];
  const binds: unknown[] = [minYield];
  if (status) { wheres.push("status = ?"); binds.push(status); }
  if (host) { wheres.push("host = ?"); binds.push(host); }
  if (method) { wheres.push("discovery_method = ?"); binds.push(method); }
  const sql = `SELECT id, url, host, discovery_method, depth, status, expected_yield_score, likely_kind, link_text, first_seen, last_crawled_at, rejected_reason
                 FROM discovered_urls WHERE ${wheres.join(" AND ")}
                 ORDER BY expected_yield_score DESC, last_seen DESC
                 LIMIT ? OFFSET ?`;
  binds.push(limit, offset);
  const r = await c.env.DB.prepare(sql).bind(...binds).all();
  const items = r.results ?? [];
  return c.json({ items, next_offset: items.length === limit ? offset + limit : null });
});

discoveryRoute.get("/stats", async (c) => {
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM discovered_urls`).first<{ n: number }>();
  const byStatus = await c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM discovered_urls GROUP BY status`).all<{ status: string; n: number }>();
  const byMethod = await c.env.DB.prepare(`SELECT discovery_method, COUNT(*) AS n FROM discovered_urls GROUP BY discovery_method`).all<{ discovery_method: string; n: number }>();
  const frontier = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM crawl_frontier`).first<{ n: number }>();
  const runs = await c.env.DB.prepare(`SELECT id, seed_url, seed_host, status, discovered, queued, crawled, started_at, finished_at FROM discovery_runs ORDER BY started_at DESC LIMIT 20`).all();
  return c.json({
    total: total?.n ?? 0,
    frontier: frontier?.n ?? 0,
    by_status: byStatus.results ?? [],
    by_method: byMethod.results ?? [],
    recent_runs: runs.results ?? [],
  });
});

discoveryRoute.get("/graph/:urlId", async (c) => {
  const urlId = c.req.param("urlId");
  const depth = Math.min(Number(c.req.query("depth") ?? "2") || 2, 3);
  // BFS outward up to `depth` hops via SQL UNION ALLs.
  const nodes = new Map<string, Record<string, unknown>>();
  const edges: Array<{ src: string; dst: string; kind: string | null; weight: number }> = [];
  let frontier: string[] = [urlId];
  for (let d = 0; d < depth; d++) {
    if (!frontier.length) break;
    const placeholders = frontier.map(() => "?").join(",");
    const r = await c.env.DB.prepare(
      `SELECT lg.src_url_id, lg.dst_url_id, lg.link_kind, lg.weight,
              du.id AS du_id, du.url, du.host, du.discovery_method, du.expected_yield_score, du.status
         FROM link_graph lg
         JOIN discovered_urls du ON du.id = lg.dst_url_id
        WHERE lg.src_url_id IN (${placeholders})`,
    ).bind(...frontier).all<{ src_url_id: string; dst_url_id: string; link_kind: string | null; weight: number; du_id: string; url: string; host: string; discovery_method: string; expected_yield_score: number; status: string }>();
    const next: string[] = [];
    for (const row of r.results ?? []) {
      edges.push({ src: row.src_url_id, dst: row.dst_url_id, kind: row.link_kind, weight: row.weight });
      if (!nodes.has(row.du_id)) {
        nodes.set(row.du_id, { id: row.du_id, url: row.url, host: row.host, method: row.discovery_method, yield: row.expected_yield_score, status: row.status });
        next.push(row.du_id);
      }
    }
    frontier = next;
  }
  // Always include the root node.
  if (!nodes.has(urlId)) {
    const root = await c.env.DB.prepare(`SELECT id, url, host, discovery_method, expected_yield_score, status FROM discovered_urls WHERE id = ?`).bind(urlId).first<{ id: string; url: string; host: string; discovery_method: string; expected_yield_score: number; status: string }>();
    if (root) nodes.set(urlId, { id: root.id, url: root.url, host: root.host, method: root.discovery_method, yield: root.expected_yield_score, status: root.status });
  }
  return c.json({ nodes: [...nodes.values()], edges });
});

discoveryRoute.post("/urls/:id/promote", async (c) => {
  const id = c.req.param("id");
  // Manual promote = "I as an operator vouch for this URL". We mark the
  // row promoted AND enqueue it onto the frontier so the next crawl
  // batch actually fetches it. Yield is forced to 1.0 in priority so it
  // jumps ahead of heuristic candidates.
  const row = await c.env.DB.prepare(`SELECT id, host, depth FROM discovered_urls WHERE id = ?`).bind(id).first<{ id: string; host: string; depth: number }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  // Inherit the run_id from a prior frontier row if available, or
  // accept one explicitly via body. Keeps run-level metrics accurate
  // when an operator promotes a URL surfaced by a specific run.
  const body = (await c.req.json().catch(() => ({}))) as { run_id?: string };
  if (body.run_id && !(await runExists(c.env, body.run_id))) {
    return c.json({ error: "unknown_run_id" }, 400);
  }
  const prior = await c.env.DB.prepare(`SELECT run_id FROM crawl_frontier WHERE url_id = ?`).bind(id).first<{ run_id: string | null }>();
  const runId = body.run_id ?? prior?.run_id ?? null;
  await c.env.DB.prepare(`UPDATE discovered_urls SET status = 'promoted' WHERE id = ?`).bind(id).run();
  await c.env.DB.prepare(
    `INSERT INTO crawl_frontier (url_id, priority, scheduled_at, run_id)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(url_id) DO UPDATE SET priority = MAX(crawl_frontier.priority, excluded.priority),
                                       next_attempt_at = NULL,
                                       last_error = NULL,
                                       run_id = COALESCE(crawl_frontier.run_id, excluded.run_id)`,
  ).bind(id, 1.0, runId).run();
  return c.json({ ok: true, enqueued: true, run_id: runId });
});

discoveryRoute.post("/urls/:id/reject", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  await c.env.DB.prepare(`UPDATE discovered_urls SET status = 'rejected', rejected_reason = ? WHERE id = ?`).bind(body.reason?.slice(0, 200) ?? "manual", id).run();
  await c.env.DB.prepare(`DELETE FROM crawl_frontier WHERE url_id = ?`).bind(id).run();
  return c.json({ ok: true });
});

/**
 * Bulk promote/reject. Closes the spec's "bulk Promote/Reject" dashboard
 * requirement so an operator can act on filtered URL sets in one call
 * instead of clicking row-by-row. Caps at 500 ids per request to keep
 * D1 statements tractable.
 */
discoveryRoute.post("/urls/bulk", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    ids?: string[]; action?: "promote" | "reject"; reason?: string; run_id?: string;
  };
  const ids = (body.ids ?? []).filter((x) => typeof x === "string" && x.length > 0).slice(0, 500);
  if (!ids.length) return c.json({ error: "ids_required" }, 400);
  if (body.action !== "promote" && body.action !== "reject") {
    return c.json({ error: "invalid_action", allowed: ["promote", "reject"] }, 400);
  }
  if (body.run_id && !(await runExists(c.env, body.run_id))) {
    return c.json({ error: "unknown_run_id" }, 400);
  }
  const placeholders = ids.map(() => "?").join(",");

  if (body.action === "reject") {
    const reason = body.reason?.slice(0, 200) ?? "manual_bulk";
    await c.env.DB.prepare(
      `UPDATE discovered_urls SET status = 'rejected', rejected_reason = ? WHERE id IN (${placeholders})`,
    ).bind(reason, ...ids).run();
    await c.env.DB.prepare(`DELETE FROM crawl_frontier WHERE url_id IN (${placeholders})`).bind(...ids).run();
    return c.json({ ok: true, action: "reject", count: ids.length });
  }

  // Promote: mark + enqueue each row at priority=1.0. We loop because
  // each insert needs the per-row run_id inheritance logic from the
  // single-row promote path.
  const runIdOverride = body.run_id ?? null;
  let enqueued = 0;
  for (const id of ids) {
    const row = await c.env.DB.prepare(`SELECT id FROM discovered_urls WHERE id = ?`).bind(id).first<{ id: string }>();
    if (!row) continue;
    const prior = await c.env.DB.prepare(`SELECT run_id FROM crawl_frontier WHERE url_id = ?`).bind(id).first<{ run_id: string | null }>();
    const runId = runIdOverride ?? prior?.run_id ?? null;
    await c.env.DB.prepare(`UPDATE discovered_urls SET status = 'promoted' WHERE id = ?`).bind(id).run();
    await c.env.DB.prepare(
      `INSERT INTO crawl_frontier (url_id, priority, scheduled_at, run_id)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(url_id) DO UPDATE SET priority = MAX(crawl_frontier.priority, excluded.priority),
                                         next_attempt_at = NULL,
                                         last_error = NULL,
                                         run_id = COALESCE(crawl_frontier.run_id, excluded.run_id)`,
    ).bind(id, 1.0, runId).run();
    enqueued++;
  }
  return c.json({ ok: true, action: "promote", count: enqueued });
});
