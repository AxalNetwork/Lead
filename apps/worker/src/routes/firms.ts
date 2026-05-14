import { Hono } from "hono";
import type { Env } from "../types";
import { backfillFirmsFromLeads } from "../scripts/backfill-firms-from-leads";

export const firms = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const FIRM_FIELDS = [
  "name", "legal_name", "slug", "kind", "website", "domain", "logo_url",
  "hq_country_iso2", "hq_region", "hq_city",
  "geo_focus_json", "stages_json", "sectors_json", "thesis",
  "check_size_min_usd", "check_size_max_usd", "check_size_typical_usd",
  "aum_usd", "fund_count", "current_fund_name", "current_fund_size_usd",
  "lead_or_co", "portfolio_count", "unicorns_count", "exits_count",
  "notable_investments_json", "founded_year", "team_size",
  "linkedin_url", "crunchbase_url", "twitter_handle",
  "signal_nfx_url", "openvc_url", "pitchbook_url", "socials_json",
  "contact_email", "submission_url", "notes", "source_url",
  "imported_from", "status", "quality_score", "last_enriched_at",
] as const;
const FIRM_FIELD_SET = new Set<string>(FIRM_FIELDS);

function jsonish(v: unknown): unknown {
  if (Array.isArray(v) || (typeof v === "object" && v !== null)) return JSON.stringify(v);
  return v;
}
function normalize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function intOrNull(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// --------- LIST ---------
firms.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const cursor = intOrNull(c.req.query("cursor") ?? undefined); // last seen id (descending)
  const kind = c.req.query("kind");
  const country = c.req.query("country");
  const stage = c.req.query("stage");
  const sector = c.req.query("sector");
  const checkMin = intOrNull(c.req.query("check_min") ?? undefined);
  const checkMax = intOrNull(c.req.query("check_max") ?? undefined);
  const aumMin = intOrNull(c.req.query("aum_min") ?? undefined);
  const q = (c.req.query("q") ?? "").trim();

  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (cursor != null) { wheres.push("id < ?"); binds.push(cursor); }
  if (kind)    { wheres.push("kind = ?");           binds.push(kind); }
  if (country) { wheres.push("hq_country_iso2 = ?"); binds.push(country.toUpperCase()); }
  // Stages/sectors are JSON arrays; substring-match the slug between quotes.
  if (stage)   { wheres.push("stages_json LIKE ?");  binds.push(`%"${stage}"%`); }
  if (sector)  { wheres.push("sectors_json LIKE ?"); binds.push(`%"${sector}"%`); }
  if (checkMin != null) { wheres.push("check_size_typical_usd >= ?"); binds.push(checkMin); }
  if (checkMax != null) { wheres.push("check_size_typical_usd <= ?"); binds.push(checkMax); }
  if (aumMin != null)   { wheres.push("aum_usd >= ?"); binds.push(aumMin); }
  if (q) {
    wheres.push("(name LIKE ? OR thesis LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const r = await c.env.DB
    .prepare(`SELECT * FROM firms ${whereSql} ORDER BY id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (items[items.length - 1].id as number) : null;
  return c.json({ items, nextCursor });
});

// --------- GET BY ID (with people[] + portfolio[]) ---------
firms.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const firm = await c.env.DB.prepare("SELECT * FROM firms WHERE id = ?").bind(id).first();
  if (!firm) return c.json({ error: "not_found" }, 404);

  const people = await c.env.DB
    .prepare(
      `SELECT fp.id AS firm_people_id, fp.role, fp.is_decision_maker, fp.started_at, fp.ended_at, fp.source_url AS link_source_url,
              l.id, l.name, l.email, l.title, l.org, l.linkedin_url, l.twitter_url, l.persona_role, l.seniority,
              l.country_iso2, l.region, l.city
       FROM firm_people fp
       LEFT JOIN leads l ON l.id = fp.lead_id
       WHERE fp.firm_id = ?
       ORDER BY fp.is_decision_maker DESC, fp.id ASC`,
    )
    .bind(id)
    .all();
  const portfolio = await c.env.DB
    .prepare("SELECT * FROM firm_portfolio WHERE firm_id = ? ORDER BY investment_year DESC, id DESC")
    .bind(id)
    .all();
  return c.json({ ...firm, people: people.results ?? [], portfolio: portfolio.results ?? [] });
});

// --------- CREATE ---------
firms.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "bad_request", message: "name required" }, 400);
  }
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const f of FIRM_FIELDS) {
    if (f in body) { cols.push(f); values.push(jsonish(body[f]) ?? null); }
  }
  if (!cols.includes("slug")) {
    cols.push("slug"); values.push(slugify(String(body.name)));
  }
  const placeholders = cols.map(() => "?").join(",");
  const r = await c.env.DB
    .prepare(`INSERT INTO firms (${cols.join(",")}) VALUES (${placeholders})`)
    .bind(...values)
    .run();
  const newId = (r.meta.last_row_id as number) ?? null;
  const created = newId != null
    ? await c.env.DB.prepare("SELECT * FROM firms WHERE id = ?").bind(newId).first()
    : null;
  return c.json(created, 201);
});

// --------- PATCH (with audit) ---------
firms.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "bad_request" }, 400);

  const before = await c.env.DB
    .prepare("SELECT * FROM firms WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!before) return c.json({ error: "not_found" }, 404);

  const setParts: string[] = [];
  const setValues: unknown[] = [];
  const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  for (const k of Object.keys(body)) {
    if (!FIRM_FIELD_SET.has(k)) continue;
    const next = jsonish(body[k]) ?? null;
    const prev = before[k] ?? null;
    if (normalize(next) === normalize(prev)) continue;
    setParts.push(`${k} = ?`);
    setValues.push(next);
    changes.push({ field: k, oldValue: prev, newValue: next });
  }
  if (!setParts.length) return c.json({ ok: true, changed: 0 });

  const now = new Date().toISOString();
  setParts.push("last_modified = ?");
  setValues.push(now);
  setValues.push(id);
  await c.env.DB
    .prepare(`UPDATE firms SET ${setParts.join(", ")} WHERE id = ?`)
    .bind(...setValues)
    .run();

  const email = c.get("email");
  const stmts = changes.map((ch) =>
    c.env.DB
      .prepare(
        `INSERT INTO firm_history (id, firm_id, field, old_value, new_value, source, evidence_url, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        ch.field,
        ch.oldValue == null ? null : String(ch.oldValue),
        ch.newValue == null ? null : String(ch.newValue),
        "ui:patch",
        null,
        email ?? null,
        now,
      ),
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, changed: changes.length });
});

// --------- HISTORY ---------
firms.get("/:id/history", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_request" }, 400);
  const r = await c.env.DB
    .prepare(
      `SELECT id, field, old_value, new_value, source, evidence_url, changed_by, changed_at
       FROM firm_history WHERE firm_id = ? ORDER BY changed_at DESC LIMIT 200`,
    )
    .bind(id)
    .all();
  return c.json({ items: r.results ?? [] });
});

// --------- ATTACH PERSON ---------
firms.post("/:id/people", async (c) => {
  const firmId = Number(c.req.param("id"));
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const body = (await c.req.json().catch(() => null)) as
    | { lead_id?: unknown; role?: unknown; is_decision_maker?: unknown; started_at?: unknown; ended_at?: unknown; source_url?: unknown }
    | null;
  if (!body || typeof body.lead_id !== "string" || !body.lead_id.trim()) {
    return c.json({ error: "bad_request", message: "lead_id required" }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT id FROM firms WHERE id = ?").bind(firmId).first();
  if (!exists) return c.json({ error: "not_found" }, 404);
  const role = typeof body.role === "string" ? body.role : null;
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO firm_people (firm_id, lead_id, role, is_decision_maker, started_at, ended_at, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        firmId,
        body.lead_id,
        role,
        body.is_decision_maker ? 1 : 0,
        typeof body.started_at === "string" ? body.started_at : null,
        typeof body.ended_at === "string" ? body.ended_at : null,
        typeof body.source_url === "string" ? body.source_url : null,
      )
      .run();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("UNIQUE")) return c.json({ error: "duplicate" }, 409);
    throw e;
  }
  return c.json({ ok: true }, 201);
});

// --------- DETACH PERSON ---------
firms.delete("/:id/people/:leadId", async (c) => {
  const firmId = Number(c.req.param("id"));
  const leadId = c.req.param("leadId");
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const r = await c.env.DB
    .prepare("DELETE FROM firm_people WHERE firm_id = ? AND lead_id = ?")
    .bind(firmId, leadId)
    .run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

// --------- ADD PORTFOLIO COMPANY ---------
firms.post("/:id/portfolio", async (c) => {
  const firmId = Number(c.req.param("id"));
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.company_name !== "string" || !body.company_name.trim()) {
    return c.json({ error: "bad_request", message: "company_name required" }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT id FROM firms WHERE id = ?").bind(firmId).first();
  if (!exists) return c.json({ error: "not_found" }, 404);
  const r = await c.env.DB
    .prepare(
      `INSERT INTO firm_portfolio
        (firm_id, company_name, company_domain, company_url, investment_year, stage, amount_usd, is_lead, outcome, exit_value_usd, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      firmId,
      String(body.company_name).trim(),
      typeof body.company_domain === "string" ? body.company_domain : null,
      typeof body.company_url === "string" ? body.company_url : null,
      typeof body.investment_year === "number" ? body.investment_year : null,
      typeof body.stage === "string" ? body.stage : null,
      typeof body.amount_usd === "number" ? body.amount_usd : null,
      body.is_lead ? 1 : 0,
      typeof body.outcome === "string" ? body.outcome : null,
      typeof body.exit_value_usd === "number" ? body.exit_value_usd : null,
      typeof body.source_url === "string" ? body.source_url : null,
    )
    .run();
  const id = (r.meta.last_row_id as number) ?? null;
  return c.json({ ok: true, id }, 201);
});

// --------- TRIGGER TEAM-PAGE CRAWL (Task #17) ---------
firms.post("/:id/crawl-team", async (c) => {
  const firmId = Number(c.req.param("id"));
  if (!Number.isFinite(firmId)) return c.json({ error: "bad_request" }, 400);
  const firm = await c.env.DB
    .prepare("SELECT id, name, website, domain FROM firms WHERE id = ?")
    .bind(firmId)
    .first<{ id: number; name: string; website: string | null; domain: string | null }>();
  if (!firm) return c.json({ error: "not_found" }, 404);
  // Synthesize a homepage URL from website or https://{domain}. We refuse
  // to enqueue when neither is present — there's nothing to crawl.
  let target: string | null = null;
  if (firm.website) {
    try { target = new URL(firm.website).toString(); } catch { target = null; }
  }
  if (!target && firm.domain) {
    try { target = new URL(`https://${firm.domain}`).toString(); } catch { target = null; }
  }
  if (!target) return c.json({ error: "bad_request", message: "firm has no website or domain" }, 400);

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const source = firm.domain ?? "";
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'firm_team_crawl', ?, ?, ?, ?)`,
  ).bind(
    jobId,
    `firm_team_crawl:${firm.name}`,
    source,
    target,
    JSON.stringify({ firmId: firm.id, requested_by: c.get("email") ?? null }),
    now,
    now,
  ).run();
  await c.env.LEAD_QUEUE.send({
    jobId,
    kind: "firm_team_crawl",
    target,
    config: { firmId: firm.id },
  });
  return c.json({ ok: true, job_id: jobId }, 202);
});

// --------- BACKFILL FROM LEADS (admin one-shot) ---------
firms.post("/_backfill", async (c) => {
  const summary = await backfillFirmsFromLeads(c.env);
  return c.json({ ok: true, ...summary });
});
