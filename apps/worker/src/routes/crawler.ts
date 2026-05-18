// Task #6: Crawler API. All endpoints sit behind accessGuard
// (single-operator). Preview mode runs fetch + extractor without
// committing; enqueue writes to the frontier table; the host endpoint
// surfaces politeness state + recent attempts so the (separate)
// operator console can read it.

import { Hono } from "hono";
import type { Env } from "../types";
import { previewUrl, enqueueFrontier, getHostState, recentLog } from "../crawler";

export const crawlerRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

crawlerRoute.post("/fetch", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string; profile_type_hint?: string };
  const url = String(body.url ?? "").trim();
  if (!url) return c.json({ error: "url_required" }, 400);
  try { new URL(url); } catch { return c.json({ error: "invalid_url" }, 400); }
  const r = await previewUrl(c.env, url, { profileTypeHint: body.profile_type_hint });
  return c.json(r);
});

crawlerRoute.post("/enqueue", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string; profile_type_hint?: string; priority?: number };
  const url = String(body.url ?? "").trim();
  if (!url) return c.json({ error: "url_required" }, 400);
  try { new URL(url); } catch { return c.json({ error: "invalid_url" }, 400); }
  try {
    const r = await enqueueFrontier(c.env, url, {
      profileTypeHint: body.profile_type_hint,
      priority: Number(body.priority ?? 0),
      byEmail: c.get("email") ?? null,
    });
    return c.json(r, 202);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

crawlerRoute.get("/host/:host", async (c) => {
  const host = c.req.param("host").toLowerCase();
  if (!host) return c.json({ error: "host_required" }, 400);
  const state = await getHostState(c.env, host);
  const log = await recentLog(c.env, host, 25);
  return c.json({ host, state, recent: log });
});
