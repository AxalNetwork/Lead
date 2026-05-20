// Task #2 (People): list-mode API for /dashboard/people/.
//
// GET /api/people — paginated list of every u_entities row with
// kind='person' and status='active', joined to entity_roles (json
// aggregate per row) so the list page can render the per-row role
// chips + cross-list badges without a second roundtrip.
//
// POST /api/leads/promote — lives in `routes/leads_promote.ts`.
//
// Behind the existing accessGuard (mounted under /api/* in src/index.ts).

import { Hono } from "hono";
import type { Env } from "../types";

export const peopleRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

interface PeopleRow {
  id: string;
  display_name: string | null;
  primary_url: string | null;
  primary_domain: string | null;
  primary_email_key: string | null;
  primary_linkedin_key: string | null;
  created_at: string;
  updated_at: string;
  roles_json: string | null;
}

peopleRoute.get("/", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const role = (c.req.query("role") ?? "").trim().toLowerCase();
  const sourceEmail = (c.req.query("source_email") ?? "").trim().toLowerCase();

  const wheres: string[] = ["e.kind = 'person'", "e.status = 'active'"];
  const binds: unknown[] = [];
  if (q) {
    wheres.push(
      "(lower(COALESCE(e.display_name,'')) LIKE ? OR lower(COALESCE(e.primary_domain,'')) LIKE ? OR lower(COALESCE(e.primary_email_key,'')) LIKE ?)",
    );
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (role) {
    wheres.push("EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = ?)");
    binds.push(role);
  }
  if (sourceEmail) {
    // Filter by leads.owner_email via legacy map join. Best-effort —
    // only matches entities ingested through the legacy leads table.
    wheres.push(
      "EXISTS (SELECT 1 FROM entity_legacy_map m JOIN leads l ON l.id = m.legacy_id WHERE m.legacy_table='leads' AND m.entity_id = e.id AND lower(COALESCE(l.owner_email,'')) = ?)",
    );
    binds.push(sourceEmail);
  }
  const whereSql = `WHERE ${wheres.join(" AND ")}`;

  const sql = `
    SELECT e.id, e.display_name, e.primary_url, e.primary_domain,
           e.primary_email_key, e.primary_linkedin_key,
           e.created_at, e.updated_at,
           (SELECT json_group_array(r.role) FROM entity_roles r WHERE r.entity_id = e.id) AS roles_json
      FROM u_entities e
      ${whereSql}
     ORDER BY e.created_at DESC
     LIMIT ? OFFSET ?`;
  let rows: PeopleRow[] = [];
  try {
    const r = await c.env.DB.prepare(sql).bind(...binds, limit + 1, offset).all<PeopleRow>();
    rows = r.results ?? [];
  } catch (e) {
    console.warn("people.list failed", (e as Error).message);
    return c.json({ items: [], next_offset: null, error: "list_failed" });
  }
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map((row) => {
    let roles: string[] = [];
    try {
      const parsed = row.roles_json ? JSON.parse(row.roles_json) : [];
      if (Array.isArray(parsed)) roles = parsed.filter((s): s is string => typeof s === "string");
    } catch { /* roles_json malformed → empty list */ }
    return {
      id: row.id,
      display_name: row.display_name,
      primary_url: row.primary_url,
      primary_domain: row.primary_domain,
      primary_email_key: row.primary_email_key,
      primary_linkedin_key: row.primary_linkedin_key,
      created_at: row.created_at,
      updated_at: row.updated_at,
      roles,
    };
  });
  return c.json({ items, next_offset: hasMore ? offset + limit : null });
});
