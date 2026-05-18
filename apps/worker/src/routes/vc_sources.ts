// Task #3: VC Source Registry — operator API.
//
// Mounted under /api/vc-sources after accessGuard (in src/index.ts) so every
// caller is the allowlisted operator. PATCH is additionally admin-only.
//
//   GET    /api/vc-sources                    list w/ filters + priority sort
//   GET    /api/vc-sources/health             freshness lag per source
//   GET    /api/vc-sources/data-types         distinct data_type catalog
//   GET    /api/vc-sources/jurisdictions      distinct jurisdiction catalog
//   GET    /api/vc-sources/:id                single source detail
//   PATCH  /api/vc-sources/:id                toggle enabled / change priority

import { Hono } from "hono";
import type { Env } from "../types";
import { selectSourcesFor } from "../services/sourceSelector";

export const vcSourcesRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

interface VcSourceDbRow {
  id: string;
  jurisdiction: string;
  authority: string;
  data_type: string;
  source_name: string;
  base_url: string;
  access_pattern: string;
  refresh_cadence: string;
  authentication: string;
  auth_notes: string | null;
  historical_depth: string | null;
  data_fields_json: string;
  seed_url_template: string | null;
  enabled: number;
  priority: number;
  last_crawled_at: string | null;
  last_success_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function safeFields(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

function hydrate(r: VcSourceDbRow): Record<string, unknown> {
  const { data_fields_json, ...rest } = r;
  return { ...rest, data_fields: safeFields(data_fields_json) };
}

// GET /api/vc-sources?data_type=&jurisdiction=&authority=&enabled=&yields_field=&limit=
vcSourcesRoute.get("/", async (c) => {
  const dataType    = c.req.query("data_type");
  const jurisdict   = c.req.query("jurisdiction");
  const authority   = c.req.query("authority");
  const enabledQ    = c.req.query("enabled");
  const yieldsField = c.req.query("yields_field");
  const limit       = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? "100")));

  const wheres: string[] = [];
  const binds: Array<string | number> = [];
  if (dataType)  { wheres.push("data_type = ?");    binds.push(dataType); }
  if (jurisdict) { wheres.push("jurisdiction = ?"); binds.push(jurisdict); }
  if (authority) { wheres.push("authority = ?");    binds.push(authority); }
  if (enabledQ === "1" || enabledQ === "0") { wheres.push("enabled = ?"); binds.push(Number(enabledQ)); }
  const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  const r = await c.env.DB.prepare(
    `SELECT id, jurisdiction, authority, data_type, source_name, base_url,
            access_pattern, refresh_cadence, authentication, auth_notes,
            historical_depth, data_fields_json, seed_url_template, enabled,
            priority, last_crawled_at, last_success_at, notes, created_at, updated_at
       FROM vc_sources ${where}
       ORDER BY priority DESC, jurisdiction ASC, authority ASC, source_name ASC
       LIMIT ?`,
  ).bind(...binds, limit).all<VcSourceDbRow>();

  let rows = (r.results ?? []).map(hydrate);
  if (yieldsField) rows = rows.filter((row) => (row.data_fields as string[]).includes(yieldsField));
  return c.json({ count: rows.length, sources: rows });
});

// GET /api/vc-sources/health — freshness lag (stalest enabled first).
vcSourcesRoute.get("/health", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id, jurisdiction, authority, data_type, source_name, refresh_cadence,
            enabled, priority, last_crawled_at, last_success_at,
            CASE
              WHEN last_success_at IS NULL THEN NULL
              ELSE CAST((julianday('now') - julianday(last_success_at)) AS INTEGER)
            END AS lag_days
       FROM vc_sources
      ORDER BY enabled DESC,
               CASE WHEN last_success_at IS NULL THEN 1 ELSE 0 END,
               last_success_at ASC,
               priority DESC`,
  ).all<{
    id: string; jurisdiction: string; authority: string; data_type: string;
    source_name: string; refresh_cadence: string; enabled: number; priority: number;
    last_crawled_at: string | null; last_success_at: string | null; lag_days: number | null;
  }>();
  const items = r.results ?? [];
  const never_succeeded = items.filter((x) => x.enabled === 1 && x.last_success_at === null).length;
  const enabled_total   = items.filter((x) => x.enabled === 1).length;
  return c.json({ count: items.length, enabled_total, never_succeeded, sources: items });
});

vcSourcesRoute.get("/data-types", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT data_type, COUNT(*) AS n
       FROM vc_sources WHERE enabled = 1
      GROUP BY data_type ORDER BY n DESC, data_type ASC`,
  ).all<{ data_type: string; n: number }>();
  return c.json({ data_types: r.results ?? [] });
});

vcSourcesRoute.get("/jurisdictions", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT jurisdiction, COUNT(*) AS n
       FROM vc_sources WHERE enabled = 1
      GROUP BY jurisdiction ORDER BY n DESC, jurisdiction ASC`,
  ).all<{ jurisdiction: string; n: number }>();
  return c.json({ jurisdictions: r.results ?? [] });
});

// GET /api/vc-sources/select?data_type=&jurisdiction=&authority=&yields_field=
// Wraps services/sourceSelector.ts so operators / orchestrators can preview
// the source-picking logic without re-implementing the priority sort.
vcSourcesRoute.get("/select", async (c) => {
  const dataType = c.req.query("data_type");
  if (!dataType) return c.json({ error: "data_type_required" }, 400);
  const rows = await selectSourcesFor(c.env, {
    data_type: dataType,
    jurisdiction: c.req.query("jurisdiction") ?? undefined,
    authority:    c.req.query("authority") ?? undefined,
    yields_field: c.req.query("yields_field") ?? undefined,
    limit: Math.max(1, Math.min(100, Number(c.req.query("limit") ?? "20"))),
  });
  return c.json({ count: rows.length, sources: rows });
});

// GET /api/vc-sources/:id — keep AFTER the static segments above so Hono
// doesn't route /health, /data-types, /jurisdictions, /select to this.
vcSourcesRoute.get("/:id", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id, jurisdiction, authority, data_type, source_name, base_url,
            access_pattern, refresh_cadence, authentication, auth_notes,
            historical_depth, data_fields_json, seed_url_template, enabled,
            priority, last_crawled_at, last_success_at, notes, created_at, updated_at
       FROM vc_sources WHERE id = ?`,
  ).bind(c.req.param("id")).first<VcSourceDbRow>();
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(hydrate(r));
});

// PATCH /api/vc-sources/:id  { enabled?, priority?, notes? }
// Admin-only — operators toggle individual sources without re-running the
// seed migration. Idempotent.
vcSourcesRoute.patch("/:id", async (c) => {
  if (c.var.is_admin !== true) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<{ enabled?: boolean | number; priority?: number; notes?: string | null }>().catch(() => ({} as { enabled?: boolean | number; priority?: number; notes?: string | null }));
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];
  if (typeof body.enabled === "boolean" || typeof body.enabled === "number") {
    sets.push("enabled = ?");
    binds.push(body.enabled ? 1 : 0);
  }
  if (typeof body.priority === "number" && Number.isFinite(body.priority)) {
    const p = Math.max(0, Math.min(100, Math.round(body.priority)));
    sets.push("priority = ?");
    binds.push(p);
  }
  if (body.notes === null || typeof body.notes === "string") {
    sets.push("notes = ?");
    binds.push(body.notes ?? null);
  }
  if (sets.length === 0) return c.json({ error: "no_fields" }, 400);
  sets.push("updated_at = CURRENT_TIMESTAMP");
  const r = await c.env.DB.prepare(
    `UPDATE vc_sources SET ${sets.join(", ")} WHERE id = ?`,
  ).bind(...binds, id).run();
  const meta = r.meta as { changes?: number } | undefined;
  if ((meta?.changes ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  const after = await c.env.DB.prepare(
    `SELECT id, enabled, priority, notes, updated_at FROM vc_sources WHERE id = ?`,
  ).bind(id).first();
  return c.json({ ok: true, source: after });
});
