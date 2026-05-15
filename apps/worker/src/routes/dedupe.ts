import { Hono } from "hono";
import type { Env } from "../types";
import type { Lead } from "../db/leads.types";
import { LeadsRepo } from "../db/leads.repo";
import { mergeIntoExisting, markMerged, type IncomingLead } from "../dedupe/merge";

export const dedupe = new Hono<{ Bindings: Env; Variables: { email: string } }>();

dedupe.get("/review", async (c) => {
  const status = c.req.query("status") ?? "open";
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const r = await c.env.DB.prepare(
    `SELECT r.id, r.primary_lead_id, r.candidate_lead_id, r.score, r.reasons_json, r.status, r.created_at,
            r.skip_until, r.resolved_by, r.resolved_at,
            p.name AS primary_name, p.email AS primary_email, p.org AS primary_org, p.source_url AS primary_source_url,
            cnd.name AS candidate_name, cnd.email AS candidate_email, cnd.org AS candidate_org, cnd.source_url AS candidate_source_url
       FROM dedupe_review r
       LEFT JOIN leads p   ON p.id   = r.primary_lead_id
       LEFT JOIN leads cnd ON cnd.id = r.candidate_lead_id
       WHERE r.status = ?
         AND (r.skip_until IS NULL OR datetime(r.skip_until) <= datetime('now'))
       ORDER BY r.created_at DESC LIMIT ?`,
  )
    .bind(status, limit)
    .all();
  return c.json({ items: r.results ?? [] });
});

dedupe.get("/review/:id", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM dedupe_review WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!r) return c.json({ error: "not_found" }, 404);
  const repo = new LeadsRepo(c.env.DB, c.env);
  const [primary, candidate] = await Promise.all([
    repo.getById(r.primary_lead_id as string),
    repo.getById(r.candidate_lead_id as string),
  ]);
  return c.json({ review: r, primary, candidate });
});

dedupe.post("/review/:id/merge", async (c) => {
  const id = c.req.param("id");
  const review = await c.env.DB.prepare("SELECT * FROM dedupe_review WHERE id = ?").bind(id).first<{
    primary_lead_id: string;
    candidate_lead_id: string;
    status: string;
  }>();
  if (!review) return c.json({ error: "not_found" }, 404);
  if (review.status !== "open") return c.json({ error: "already_resolved" }, 409);

  const repo = new LeadsRepo(c.env.DB, c.env);
  const primary = await repo.getById(review.primary_lead_id);
  const candidate = await repo.getById(review.candidate_lead_id);
  if (!primary || !candidate) return c.json({ error: "missing_leads" }, 404);

  const ctx = { source: "ui:dedupe_merge", changed_by: c.get("email") };
  // Promote candidate's evidence into primary, then mark candidate as merged.
  const incoming: IncomingLead = leadToIncoming(candidate);
  await mergeIntoExisting(c.env.DB, primary, incoming, ctx, {}, c.env);
  await markMerged(c.env.DB, primary.id, candidate.id, ctx, c.env);

  await c.env.DB.prepare(
    "UPDATE dedupe_review SET status = 'merged', resolved_by = ?, resolved_at = ? WHERE id = ?",
  )
    .bind(c.get("email"), new Date().toISOString(), id)
    .run();

  return c.json({ ok: true, primary_lead_id: primary.id });
});

dedupe.post("/review/:id/reject", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { skip_days?: number };
  const skipDays = typeof body.skip_days === "number" ? Math.max(0, Math.min(365, body.skip_days)) : 0;
  const skipUntil = skipDays > 0 ? new Date(Date.now() + skipDays * 86_400_000).toISOString() : null;
  const status = skipDays > 0 ? "open" : "rejected";
  const r = await c.env.DB.prepare(
    "UPDATE dedupe_review SET status = ?, skip_until = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
  )
    .bind(status, skipUntil, c.get("email"), skipDays > 0 ? null : new Date().toISOString(), id)
    .run();
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, status, skip_until: skipUntil });
});

function leadToIncoming(lead: Lead): IncomingLead {
  return {
    email: lead.email,
    phone: lead.phone ?? null,
    linkedin_url: lead.linkedin_url ?? null,
    twitter_url: lead.twitter_url ?? null,
    github_url: lead.github_url ?? null,
    personal_url: lead.personal_url ?? null,
    name: lead.name,
    org: lead.org,
    title: lead.title,
    category: lead.category,
    bio: lead.bio ?? null,
    country_iso2: lead.country_iso2 ?? null,
    region: lead.region ?? null,
    city: lead.city ?? null,
    timezone: lead.timezone ?? null,
    source_domain: lead.source_domain,
    source_url: lead.source_url,
    alt_emails: parseStringArray(lead.alt_emails_json),
    tags: parseStringArray(lead.tags_json),
    provider: lead.provider ?? null,
  };
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}
