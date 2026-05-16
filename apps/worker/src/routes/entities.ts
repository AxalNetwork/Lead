// Task #4: unified entity graph routes (additive — legacy reads still
// served by /api/firms, /api/leads, etc.).

import { Hono } from "hono";
import type { Env } from "../types";
import { loadEntity, searchEntities, type SearchFilter } from "../entities/query";
import { mergeEntities } from "../entities/merge";
import { rebuildSummary } from "../entities/summary";
import {
  backfillFirms, backfillLeads, backfillCompanies,
  backfillAccounts, backfillBuyers, backfillAll,
} from "../entities/backfill";

export const entitiesRoute = new Hono<{ Bindings: Env; Variables: { email: string; request_id: string } }>();

entitiesRoute.get("/", async (c) => {
  const q = c.req.query();
  const f: SearchFilter = {
    kind: (q.kind === "person" || q.kind === "org") ? q.kind : undefined,
    role: q.role,
    country_iso2: q.country,
    sector: q.sector,
    stage: q.stage,
    geo: q.geo,
    has_role: q.has_role,
    has_unicorn: q.has_unicorn === "1" || q.has_unicorn === "true",
    check_min_usd: numQ(q.check_min_usd),
    check_max_usd: numQ(q.check_max_usd),
    min_fit: numQ(q.min_fit),
    min_intent: numQ(q.min_intent),
    q: q.q,
    sort: (["fit", "intent", "quality", "updated"] as const).includes(q.sort as never)
      ? (q.sort as SearchFilter["sort"]) : undefined,
    limit: numQ(q.limit),
    offset: numQ(q.offset),
  };
  const res = await searchEntities(c.env, f);
  return c.json(res);
});

entitiesRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const includeNonCurrent = c.req.query("include_history") === "1";
  const ent = await loadEntity(c.env, id, { includeNonCurrent });
  if (!ent) return c.json({ error: "not_found" }, 404);
  return c.json(ent);
});

entitiesRoute.post("/:id/merge", async (c) => {
  const primary = c.req.param("id");
  let body: { secondary_id?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  if (!body.secondary_id) return c.json({ error: "secondary_id_required" }, 400);
  try {
    const result = await mergeEntities(c.env, primary, body.secondary_id);
    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ error: "merge_failed", message: (e as Error).message }, 400);
  }
});

entitiesRoute.post("/:id/rebuild-summary", async (c) => {
  const id = c.req.param("id");
  const ok = await rebuildSummary(c.env, id);
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// Admin-only backfill. Allowlisted operator already enforced by accessGuard.
entitiesRoute.post("/admin/backfill", async (c) => {
  let body: { table?: string; offset?: number; batches?: number; limit?: number } = {};
  try { body = (await c.req.json()) as never; } catch { /* allow empty body */ }
  const table = body.table;
  const offset = Math.max(0, Number(body.offset ?? 0));
  const limit = Math.min(Math.max(1, Number(body.limit ?? 200)), 500);
  const batches = Math.min(Math.max(1, Number(body.batches ?? 1)), 50);
  try {
    if (!table) {
      const out = await backfillAll(c.env, { batches });
      return c.json({ ok: true, batches: out });
    }
    const fn = ({
      firms: backfillFirms,
      leads: backfillLeads,
      companies: backfillCompanies,
      accounts: backfillAccounts,
      buyers: backfillBuyers,
    } as const)[table as "firms" | "leads" | "companies" | "accounts" | "buyers"];
    if (!fn) return c.json({ error: "unknown_table" }, 400);
    let cur = offset;
    const results = [];
    for (let i = 0; i < batches; i++) {
      const p = await fn(c.env, cur, limit);
      results.push(p);
      if (!p.next_offset) break;
      cur = p.next_offset;
    }
    return c.json({ ok: true, batches: results });
  } catch (e) {
    return c.json({ error: "backfill_failed", message: (e as Error).message }, 500);
  }
});

function numQ(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
