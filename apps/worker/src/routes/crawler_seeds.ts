// Task #3: Crawler-seeds + smart-frontier operator API.
//
// All endpoints sit behind `accessGuard` (mounted in src/index.ts), which
// already restricts traffic to the allowlisted operator email. Mutating
// endpoints additionally require the caller to be the operator (same
// allowlist — defensive: a future multi-tenant rollout shouldn't bypass).

import { Hono } from "hono";
import type { Env } from "../types";
import { getType } from "../services/profileTypes";
import { runSeedSweep, runSeedById } from "../services/crawlerSeeds/sweep";
import { canonicalizeUrl } from "../discovery/canonical";

export const crawlerSeedsRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function isOperator(c: { env: Env; var: { email: string } }): boolean {
  const allowed = c.env.ALLOWED_EMAIL?.toLowerCase() ?? "";
  const caller = (c.var.email ?? "").toLowerCase();
  return allowed !== "" && caller === allowed;
}

interface SeedRow {
  id: string;
  profile_type_id: string;
  seed_kind: string;
  value: string;
  refresh_interval_hours: number;
  last_crawled_at: string | null;
  success_count: number;
  entity_count: number;
  enabled: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// GET /api/crawler-seeds?profile_type_id=…&enabled=1
crawlerSeedsRoute.get("/", async (c) => {
  const profileTypeId = c.req.query("profile_type_id");
  const enabledQ = c.req.query("enabled");
  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? "100")));

  const wheres: string[] = [];
  const binds: Array<string | number> = [];
  if (profileTypeId) { wheres.push("profile_type_id = ?"); binds.push(profileTypeId); }
  if (enabledQ === "1" || enabledQ === "0") { wheres.push("enabled = ?"); binds.push(Number(enabledQ)); }
  const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  const rows = await c.env.DB.prepare(
    `SELECT id, profile_type_id, seed_kind, value, refresh_interval_hours,
            last_crawled_at, success_count, entity_count, enabled, notes,
            created_at, updated_at
       FROM crawler_seeds ${where}
       ORDER BY profile_type_id, seed_kind, value
       LIMIT ?`,
  ).bind(...binds, limit).all<SeedRow>();

  return c.json({ count: rows.results?.length ?? 0, seeds: rows.results ?? [] });
});

// POST /api/crawler-seeds  { profile_type_id, seed_kind, value, refresh_interval_hours?, enabled?, notes? }
crawlerSeedsRoute.post("/", async (c) => {
  if (!isOperator(c)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{
    profile_type_id?: string;
    seed_kind?: string;
    value?: string;
    refresh_interval_hours?: number;
    enabled?: boolean;
    notes?: string | null;
  }>().catch(() => ({} as {
    profile_type_id?: string; seed_kind?: string; value?: string;
    refresh_interval_hours?: number; enabled?: boolean; notes?: string | null;
  }));

  const profileTypeId = String(body.profile_type_id ?? "");
  const seedKind = String(body.seed_kind ?? "");
  let value = String(body.value ?? "").trim();
  if (!profileTypeId || !seedKind || !value) return c.json({ error: "missing_fields" }, 400);
  if (!["url", "search_query", "directory_pattern"].includes(seedKind)) return c.json({ error: "bad_seed_kind" }, 400);
  // Normalize URL seeds to canonical form at the write boundary so
  // downstream recordSeedEntitiesByUrl matches deterministically.
  if (seedKind === "url") {
    const can = canonicalizeUrl(value);
    if (!can || can.scheme === "other") return c.json({ error: "bad_url" }, 400);
    value = can.url;
  }

  // FK guard up front so callers get a friendly 400 instead of an opaque
  // SQLite constraint error.
  const t = await getType(c.env, profileTypeId);
  if (!t) return c.json({ error: "unknown_profile_type_id" }, 400);

  const refresh = Math.max(1, Math.min(8760, Number(body.refresh_interval_hours ?? 168)));
  const enabled = body.enabled === false ? 0 : 1;
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 500) : null;
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO crawler_seeds (id, profile_type_id, seed_kind, value, refresh_interval_hours, enabled, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_type_id, seed_kind, value) DO UPDATE SET
         refresh_interval_hours = excluded.refresh_interval_hours,
         enabled                = excluded.enabled,
         notes                  = excluded.notes,
         updated_at             = CURRENT_TIMESTAMP`,
    ).bind(id, profileTypeId, seedKind, value, refresh, enabled, notes).run();
  } catch (e) {
    return c.json({ error: "insert_failed", detail: (e as Error).message }, 500);
  }
  const row = await c.env.DB.prepare(
    `SELECT id, profile_type_id, seed_kind, value, refresh_interval_hours,
            last_crawled_at, success_count, entity_count, enabled, notes,
            created_at, updated_at
       FROM crawler_seeds WHERE profile_type_id = ? AND seed_kind = ? AND value = ?`,
  ).bind(profileTypeId, seedKind, value).first<SeedRow>();
  return c.json({ seed: row });
});

// PATCH /api/crawler-seeds/:id { enabled?, refresh_interval_hours?, notes? }
crawlerSeedsRoute.patch("/:id", async (c) => {
  if (!isOperator(c)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<{ enabled?: boolean; refresh_interval_hours?: number; notes?: string | null }>().catch(() => ({} as { enabled?: boolean; refresh_interval_hours?: number; notes?: string | null }));
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];
  if (typeof body.enabled === "boolean") { sets.push("enabled = ?"); binds.push(body.enabled ? 1 : 0); }
  if (typeof body.refresh_interval_hours === "number") {
    const v = Math.max(1, Math.min(8760, Math.floor(body.refresh_interval_hours)));
    sets.push("refresh_interval_hours = ?"); binds.push(v);
  }
  if (body.notes === null || typeof body.notes === "string") {
    sets.push("notes = ?"); binds.push(body.notes === null ? null : body.notes.slice(0, 500));
  }
  if (sets.length === 0) return c.json({ error: "no_changes" }, 400);
  sets.push("updated_at = CURRENT_TIMESTAMP");
  binds.push(id);
  const r = await c.env.DB.prepare(`UPDATE crawler_seeds SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  if (!r?.meta?.changes) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare(
    `SELECT id, profile_type_id, seed_kind, value, refresh_interval_hours,
            last_crawled_at, success_count, entity_count, enabled, notes,
            created_at, updated_at
       FROM crawler_seeds WHERE id = ?`,
  ).bind(id).first<SeedRow>();
  return c.json({ seed: row });
});

// POST /api/crawler-seeds/:id/run — runs exactly this seed (not the next
// stalest). Uses runSeedById so the call is deterministic regardless of
// what other rows are due in the sweep window.
crawlerSeedsRoute.post("/:id/run", async (c) => {
  if (!isOperator(c)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const result = await runSeedById(c.env, id);
  if (!result.found) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, result });
});

// Avoid an "unused import" warning when sweep is invoked only by the cron.
void runSeedSweep;

export const crawlFrontierRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

interface FrontierRow {
  id: string;
  url: string;
  host: string;
  profile_type_id: string | null;
  discovery_reason: string;
  priority: number;
  source_url: string | null;
  source_authority: number;
  novelty_score: number;
  status: string;
  discovered_at: string;
  enqueued_at: string | null;
}

// GET /api/crawl-frontier?profile_type_id=&status=&limit=
crawlFrontierRoute.get("/", async (c) => {
  const profileTypeId = c.req.query("profile_type_id");
  const status = c.req.query("status");
  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? "100")));

  const wheres: string[] = [];
  const binds: Array<string | number> = [];
  if (profileTypeId) { wheres.push("profile_type_id = ?"); binds.push(profileTypeId); }
  if (status) { wheres.push("status = ?"); binds.push(status); }
  const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  const rows = await c.env.DB.prepare(
    `SELECT id, url, host, profile_type_id, discovery_reason, priority,
            source_url, source_authority, novelty_score, status,
            discovered_at, enqueued_at
       FROM smart_frontier ${where}
       ORDER BY priority DESC, discovered_at ASC
       LIMIT ?`,
  ).bind(...binds, limit).all<FrontierRow>();

  const counts = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM smart_frontier ${where} GROUP BY status`,
  ).bind(...binds).all<{ status: string; n: number }>();

  return c.json({
    count: rows.results?.length ?? 0,
    candidates: rows.results ?? [],
    status_counts: counts.results ?? [],
  });
});
