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
  "created_at", "updated_at",
].join(", ");

leads.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const status = c.req.query("status");
  const includeMerged = c.req.query("include_merged") === "1";
  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    wheres.push("status = ?");
    binds.push(status);
  }
  if (!includeMerged) {
    wheres.push("(merged_into IS NULL OR merged_into = '')");
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const stmt = c.env.DB.prepare(
    `SELECT ${RICH_COLUMNS} FROM leads ${whereSql} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...binds, limit);
  const r = await stmt.all();
  return c.json({ items: r.results ?? [] });
});

leads.get("/:id", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare(`SELECT ${RICH_COLUMNS}, meta_json FROM leads WHERE id = ?`).bind(id).first();
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

leads.get("/:id/history", async (c) => {
  const repo = new LeadsRepo(c.env.DB);
  const items = await repo.history(c.req.param("id"));
  return c.json({ items });
});

leads.post("/:id/approve", async (c) => {
  const id = c.req.param("id");
  const repo = new LeadsRepo(c.env.DB);
  await repo.updateLead(
    id,
    { status: "approved", approved_at: new Date().toISOString(), approved_by: c.get("email") },
    { source: "ui:approve", changed_by: c.get("email") },
  );
  return c.json({ ok: true });
});
