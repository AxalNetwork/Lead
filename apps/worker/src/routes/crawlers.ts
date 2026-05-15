// Task #45: admin API for buyer-signal crawlers.
//
//   GET    /api/crawlers              list modules + enabled state + last run
//   GET    /api/crawlers/runs         recent crawler_runs rows
//   POST   /api/crawlers/:slug/run    fire-and-forget kick of a single source
//   POST   /api/crawlers/:slug/toggle { enabled: boolean }

import { Hono } from "hono";
import type { Env } from "../types";
import { listModulesWithState, getModule } from "../prospects/sources/registry";
import { setEnabled } from "../prospects/sources/_helpers";
import { runSource } from "../prospects/runCrawl";

export const crawlersRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

interface RunRow { id: string; source: string; started_at: string; finished_at: string | null; status: string; events_emitted: number; signals_inserted: number; signals_skipped: number; accounts_created: number; accounts_resolved: number; error: string | null }

crawlersRoute.get("/", async (c) => {
  const mods = await listModulesWithState(c.env);
  // Pull the most recent run per source via a window-style query.
  const lastRuns = await c.env.DB.prepare(
    `SELECT r.* FROM crawler_runs r
       JOIN (SELECT source, MAX(started_at) AS m FROM crawler_runs GROUP BY source) x
         ON x.source = r.source AND x.m = r.started_at`,
  ).all<RunRow>();
  const byId: Record<string, RunRow> = {};
  for (const row of lastRuns.results ?? []) byId[row.source] = row;
  return c.json({
    modules: mods.map((m) => ({
      slug: m.slug, label: m.label, schedule: m.schedule,
      enabled: m.enabled, envReady: m.envReady,
      bravePoweredOnly: !!m.bravePoweredOnly,
      requiresEnv: m.requiresEnv ?? null,
      docsUrl: m.docsUrl ?? null,
      lastRun: byId[m.slug] ?? null,
    })),
  });
});

crawlersRoute.get("/runs", async (c) => {
  const url = new URL(c.req.url);
  const source = url.searchParams.get("source");
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "100")), 500);
  const stmt = source
    ? c.env.DB.prepare(`SELECT * FROM crawler_runs WHERE source = ? ORDER BY started_at DESC LIMIT ?`).bind(source, limit)
    : c.env.DB.prepare(`SELECT * FROM crawler_runs ORDER BY started_at DESC LIMIT ?`).bind(limit);
  const r = await stmt.all<RunRow>();
  return c.json({ items: r.results ?? [] });
});

crawlersRoute.post("/:slug/run", async (c) => {
  const slug = c.req.param("slug");
  const mod = getModule(slug);
  if (!mod) return c.json({ error: "unknown_source" }, 404);
  // Run synchronously up to 25s — if the source is fast we return real
  // counters; otherwise the request times out at the CF edge but the run
  // continues in the background via waitUntil.
  const p = runSource(c.env, mod, { force: true });
  c.executionCtx.waitUntil(p.then(() => undefined).catch((e) => console.warn("background runSource failed", slug, (e as Error).message)));
  try {
    const outcome = await Promise.race([
      p,
      new Promise<null>((res) => setTimeout(() => res(null), 25000)),
    ]);
    if (!outcome) return c.json({ ok: true, status: "running" }, 202);
    return c.json({ ok: true, outcome });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

crawlersRoute.post("/:slug/toggle", async (c) => {
  const slug = c.req.param("slug");
  const mod = getModule(slug);
  if (!mod) return c.json({ error: "unknown_source" }, 404);
  const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null;
  if (!body || typeof body.enabled !== "boolean") return c.json({ error: "bad_request" }, 400);
  await setEnabled(c.env, slug, body.enabled);
  return c.json({ ok: true, slug, enabled: body.enabled });
});
