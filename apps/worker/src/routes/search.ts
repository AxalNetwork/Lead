// Unified semantic search (Task #25 step 8).
//
// GET /api/search?q=...&type=lead|firm|company|all&limit=20
//
// Path A (preferred): forwards to the AI Search namespace via the AI_SEARCH
// binding for true semantic ranking.
// Path B (fallback): D1 LIKE across leads/firms/companies. Substring match
// only — clearly worse than vector ranking, used when AI_SEARCH isn't
// configured so the route never 502s.

import { Hono } from "hono";
import type { Env } from "../types";

export const search = new Hono<{ Bindings: Env; Variables: { email: string } }>();

interface Hit { id: string; type: "lead" | "firm" | "company"; title: string; snippet?: string; score?: number; url?: string }

search.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const type = (c.req.query("type") ?? "all") as "lead" | "firm" | "company" | "all";
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  if (!q) return c.json({ q, items: [], source: "empty" });

  // ---- Path A: AI Search namespace ----
  if (c.env.AI_SEARCH) {
    try {
      const ns = c.env.AI_SEARCH_NAMESPACE ?? "axal-profiles";
      const res = await c.env.AI_SEARCH.fetch(
        `https://ai-search/${encodeURIComponent(ns)}/search?q=${encodeURIComponent(q)}&limit=${limit}${type === "all" ? "" : `&filter=type:${type}`}`,
      );
      if (res.ok) {
        const j = (await res.json()) as { hits?: Hit[] };
        return c.json({ q, items: j.hits ?? [], source: "ai_search" });
      }
    } catch (e) {
      console.warn("ai_search query failed", (e as Error).message);
    }
  }

  // ---- Path B: D1 LIKE fallback ----
  const like = `%${q.replace(/%/g, "")}%`;
  const items: Hit[] = [];
  if (type === "all" || type === "lead") {
    const r = await c.env.DB.prepare(
      `SELECT id, name, org, source_url FROM leads
       WHERE name LIKE ? OR org LIKE ? OR email LIKE ?
       LIMIT ?`,
    ).bind(like, like, like, limit).all<{ id: string; name: string | null; org: string | null; source_url: string | null }>();
    for (const row of r.results ?? []) {
      items.push({ id: row.id, type: "lead", title: row.name ?? row.org ?? row.id, snippet: row.org ?? "", url: row.source_url ?? undefined });
    }
  }
  if (type === "all" || type === "firm") {
    const r = await c.env.DB.prepare(
      `SELECT id, name, website FROM firms WHERE name LIKE ? OR website LIKE ? LIMIT ?`,
    ).bind(like, like, limit).all<{ id: number; name: string; website: string | null }>();
    for (const row of r.results ?? []) {
      items.push({ id: String(row.id), type: "firm", title: row.name, url: row.website ?? undefined });
    }
  }
  if (type === "all" || type === "company") {
    // companies table from Task #24
    try {
      const r = await c.env.DB.prepare(
        `SELECT id, name, website FROM companies WHERE name LIKE ? OR website LIKE ? LIMIT ?`,
      ).bind(like, like, limit).all<{ id: number; name: string; website: string | null }>();
      for (const row of r.results ?? []) {
        items.push({ id: String(row.id), type: "company", title: row.name, url: row.website ?? undefined });
      }
    } catch { /* table may not exist on older deploys */ }
  }
  return c.json({ q, items: items.slice(0, limit), source: "d1_like" });
});
