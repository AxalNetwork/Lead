import { Hono } from "hono";
import type { Env } from "../types";
import { matchIcp, type IcpRow } from "../icp/match";

export const icp = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const ICP_FIELDS = [
  "name", "description",
  "sectors_json", "geographies_json", "personas_json", "seniority_json",
  "min_aum_usd", "min_fund_size_usd", "min_quality",
  "require_email", "require_linkedin", "exclude_dnc",
  "tags_any_json", "tags_all_json", "weights_json",
];

function jsonish(v: unknown): unknown {
  if (Array.isArray(v) || (typeof v === "object" && v !== null)) return JSON.stringify(v);
  return v;
}

icp.get("/", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM icp_profiles ORDER BY created_at DESC LIMIT 200").all<IcpRow>();
  return c.json({ items: r.results ?? [] });
});

icp.get("/:id", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM icp_profiles WHERE id = ?").bind(c.req.param("id")).first<IcpRow>();
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

icp.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "bad_request", message: "name required" }, 400);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const cols = ["id", "created_by", "created_at", "updated_at", ...ICP_FIELDS];
  const values: unknown[] = [id, c.get("email"), now, now];
  for (const f of ICP_FIELDS) values.push(jsonish(body[f]) ?? null);
  const placeholders = cols.map(() => "?").join(",");
  await c.env.DB.prepare(`INSERT INTO icp_profiles (${cols.join(",")}) VALUES (${placeholders})`).bind(...values).run();
  const created = await c.env.DB.prepare("SELECT * FROM icp_profiles WHERE id = ?").bind(id).first();
  return c.json(created, 201);
});

icp.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of ICP_FIELDS) {
    if (f in body) { sets.push(`${f} = ?`); binds.push(jsonish(body[f]) ?? null); }
  }
  if (!sets.length) return c.json({ error: "bad_request", message: "no fields" }, 400);
  sets.push("updated_at = ?"); binds.push(new Date().toISOString());
  binds.push(id);
  const r = await c.env.DB.prepare(`UPDATE icp_profiles SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  if (!r.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

icp.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM icp_profiles WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

icp.get("/:id/match", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(Number(c.req.query("limit") ?? "200"), 1000);
  const min_score = c.req.query("min_score") ? Number(c.req.query("min_score")) : undefined;
  const row = await c.env.DB.prepare("SELECT * FROM icp_profiles WHERE id = ?").bind(id).first<IcpRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const out = await matchIcp(c.env.DB, row, { limit, min_score });
  return c.json(out);
});
