import { Hono } from "hono";
import type { Env } from "../types";
import { LeadsRepo } from "../db/leads.repo";

export const leads = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const RICH_COLUMNS = [
  "id", "name", "email", "phone", "org", "title", "category",
  "source_domain", "source_url", "status", "verified", "flagged",
  "approved_at", "approved_by",
  "linkedin_url", "twitter_url", "github_url", "personal_url", "alt_emails_json",
  "persona_role", "seniority", "function_area", "bio",
  "gender", "age_range", "languages_json",
  "country_iso2", "region", "city", "timezone",
  "net_worth_band", "aum_usd", "fund_size_usd", "last_round_usd", "salary_band",
  "companies_json", "board_seats_json", "awards_json", "exits_json",
  "priority", "owner_email", "next_action_at", "tags_json", "sector_focus_json",
  "merged_into", "provider", "provider_score",
  "sector_slug", "geo_slug", "do_not_contact",
  "created_at", "updated_at",
].join(", ");

leads.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const status = c.req.query("status");
  const sector = c.req.query("sector");          // taxonomy slug
  const geography = c.req.query("geography");    // geo slug or ISO2 country code
  const dnc = c.req.query("dnc");                // "1" / "0" filter
  const includeMerged = c.req.query("include_merged") === "1";
  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (status) { wheres.push("status = ?"); binds.push(status); }
  if (sector) { wheres.push("sector_slug = ?"); binds.push(sector); }
  if (geography) {
    // Match either the canonical geo_slug or the ISO2 country code (handy
    // when the caller passes "us" / "FR" rather than a metro slug).
    wheres.push("(geo_slug = ? OR country_iso2 = ?)");
    binds.push(geography, geography.toUpperCase());
  }
  if (dnc === "1") wheres.push("do_not_contact = 1");
  else if (dnc === "0") wheres.push("do_not_contact = 0");
  if (!includeMerged) wheres.push("(merged_into IS NULL OR merged_into = '')");
  // Task #2 (Leads unification): scope Leads list to entities that
  // still carry the 'lead' role (or have no role rows yet — pre-
  // classification). Once role inference promotes the entity into
  // Investors/Customers/etc, the 'lead' row is dropped by
  // POST /api/leads/promote and the entity falls off this list.
  // Pass ?include_promoted=1 to bypass for ops/debug.
  const includePromoted = c.req.query("include_promoted") === "1";
  if (!includePromoted) {
    wheres.push(
      `NOT EXISTS (
         SELECT 1 FROM entity_legacy_map m
         JOIN entity_roles r ON r.entity_id = m.entity_id
         WHERE m.legacy_table = 'leads' AND m.legacy_id = leads.id
           AND r.role IN ('investor','customer','prospect','founder','operator')
       )`,
    );
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const stmt = c.env.DB.prepare(
    `SELECT ${RICH_COLUMNS},
            (SELECT json_group_array(r.role) FROM entity_legacy_map m
               JOIN entity_roles r ON r.entity_id = m.entity_id
              WHERE m.legacy_table = 'leads' AND m.legacy_id = leads.id) AS roles_json
       FROM leads ${whereSql} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...binds, limit);
  const r = await stmt.all();
  const items = (r.results ?? []).map((row) => {
    const r2 = row as Record<string, unknown> & { roles_json?: string | null };
    let roles: string[] = [];
    try {
      const parsed = r2.roles_json ? JSON.parse(String(r2.roles_json)) : [];
      if (Array.isArray(parsed)) roles = parsed.filter((s): s is string => typeof s === "string");
    } catch { /* empty */ }
    const { roles_json: _drop, ...rest } = r2;
    void _drop;
    return { ...rest, roles };
  });
  return c.json({ items });
});

leads.get("/:id", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare(`SELECT ${RICH_COLUMNS}, meta_json FROM leads WHERE id = ?`).bind(id).first();
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

leads.get("/:id/history", async (c) => {
  const repo = new LeadsRepo(c.env.DB, c.env);
  const items = await repo.history(c.req.param("id"));
  return c.json({ items });
});

leads.post("/:id/approve", async (c) => {
  const id = c.req.param("id");
  const repo = new LeadsRepo(c.env.DB, c.env);
  await repo.updateLead(
    id,
    { status: "approved", approved_at: new Date().toISOString(), approved_by: c.get("email") },
    { source: "ui:approve", changed_by: c.get("email") },
  );
  return c.json({ ok: true });
});
