// Task #5: Profile types registry API. All endpoints sit behind
// accessGuard (single-operator allowlist). Detection is deterministic
// — no LLM — so the router and seed-discovery tasks can rely on stable,
// reproducible match results.

import { Hono } from "hono";
import type { Env } from "../types";
import { loadRegistry, getType, testPage } from "../services/profileTypes";

export const profileTypesRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

profileTypesRoute.get("/", async (c) => {
  const types = await loadRegistry(c.env);
  return c.json({ count: types.length, types });
});

profileTypesRoute.get("/:id", async (c) => {
  const t = await getType(c.env, c.req.param("id"));
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json({ type: t });
});

profileTypesRoute.post("/:id/test", async (c) => {
  const t = await getType(c.env, c.req.param("id"));
  if (!t) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ url?: string; html?: string }>().catch(() => ({} as { url?: string; html?: string }));
  const url = typeof body.url === "string" ? body.url : "";
  const html = typeof body.html === "string" ? body.html : "";
  if (!url && !html) return c.json({ error: "url_or_html_required" }, 400);
  const result = testPage(t, { url, html });
  return c.json({ type_id: t.id, ...result });
});
