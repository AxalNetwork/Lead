import { Hono } from "hono";
import type { Env } from "../types";
import { ALL_PROVIDERS } from "../enrichment/providers";
import { enrichLead } from "../enrichment/orchestrator";
import { todayUsage } from "../enrichment/budget";

// Mounted at /api/enrichment.
export const enrichment = new Hono<{ Bindings: Env; Variables: { email: string } }>();

enrichment.get("/providers", async (c) => {
  const items = ALL_PROVIDERS.map((p) => ({
    name: p.name,
    priority: p.priority,
    configured: p.isConfigured(c.env),
    // Free providers bypass the USD budget; their cap of 0 means "no spend
    // to cap", not "disabled". Surface the flag so the console can say so.
    is_free: p.isFree === true,
    daily_cap_usd: p.isFree ? null : p.dailyCapUsd(c.env),
  }));
  const usage = await todayUsage(c.env.DB);
  return c.json({ providers: items, usage_today: usage });
});

// Mounted at /api/leads — adds /:id/enrich and /enrich/bulk on top of the
// existing leads router (composed in index.ts).
export const leadsEnrichActions = new Hono<{ Bindings: Env; Variables: { email: string } }>();

leadsEnrichActions.post("/:id/enrich", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { providers?: string[]; forceRefresh?: boolean } | null;
  const out = await enrichLead(c.env, id, body ?? {});
  return c.json(out);
});

leadsEnrichActions.post("/enrich/bulk", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: string[]; forceRefresh?: boolean; providers?: string[] } | null;
  const ids = (body?.ids ?? []).filter((s) => typeof s === "string");
  if (!ids.length) return c.json({ error: "bad_request", message: "ids[] required" }, 400);
  const capped = ids.slice(0, 50);
  const results: unknown[] = [];
  for (const id of capped) {
    try {
      results.push(await enrichLead(c.env, id, { providers: body?.providers, forceRefresh: body?.forceRefresh }));
    } catch (e) {
      results.push({ leadId: id, error: (e as Error).message });
    }
  }
  return c.json({ items: results });
});
