// Task #3: Profile classifier API.
//
//   GET  /api/profile/:id                       — full profile axes + flags + summary
//   POST /api/profile/classify/:id              — classify inline (blocks on AI)
//   POST /api/profile/classify/:id/dispatch     — durable workflow dispatch
//   POST /api/profile/:id/refresh-government    — refresh appointments + donations
//   POST /api/profile/:id/override              — { field, value, note } operator pin
//   POST /api/profile/:id/donations             — { rows: [...] } manual import
//   GET  /api/profile/:id/donations             — list donations
//   GET  /api/profile/:id/appointments          — list government appointments
//   GET  /api/profile/:id/evidence              — ?axis=… evidence quotes
//   GET  /api/profile/politicians               — list politicians (filters + sort)

import { Hono } from "hono";
import type { Env } from "../types";
import { getProfileAxes, setManualOverride, getEvidence } from "../profile/repo";
import { classifyEntity, CLASSIFIER_VERSION } from "../profile/classifier";
import { refreshGovernmentAppointments } from "../profile/government";
import { refreshDonations } from "../profile/donations";

export const profileRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function parseJsonField<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

// ---------------- GET /:id ----------------

profileRoute.get("/politicians", async (c) => {
  // Note: route is defined before /:id so Hono doesn't shadow it.
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
  const minInfluence = Number(c.req.query("min_influence") ?? "0");
  const party = c.req.query("party")?.toLowerCase() ?? null;
  const jurisdiction = c.req.query("jurisdiction") ?? null;
  const ideologyAxis = c.req.query("axis") ?? null; // left_right | lib_auth | …
  const ideologyMin = c.req.query("axis_min") != null ? Number(c.req.query("axis_min")) : null;
  const ideologyMax = c.req.query("axis_max") != null ? Number(c.req.query("axis_max")) : null;

  let extraJoin = "";
  const where: string[] = [
    "u.status = 'active'",
    "(a.is_pep = 1 OR a.is_government_official = 1 OR a.primary_type IN ('politician','government_official'))",
    "COALESCE(a.political_influence, 0) >= ?",
  ];
  const bind: unknown[] = [minInfluence];

  if (party) {
    extraJoin += " JOIN government_appointments ga ON ga.entity_id = u.id ";
    where.push("lower(ga.party) LIKE ?");
    bind.push(`%${party}%`);
  }
  if (jurisdiction) {
    if (!extraJoin.includes("government_appointments")) {
      extraJoin += " JOIN government_appointments ga ON ga.entity_id = u.id ";
    }
    where.push("ga.jurisdiction = ?");
    bind.push(jurisdiction);
  }
  if (ideologyAxis && ["left_right","lib_auth","prog_cons","glob_nat","sec_rel"].includes(ideologyAxis)) {
    if (ideologyMin != null) { where.push(`a.${ideologyAxis} >= ?`); bind.push(ideologyMin); }
    if (ideologyMax != null) { where.push(`a.${ideologyAxis} <= ?`); bind.push(ideologyMax); }
  }

  const sql = `SELECT DISTINCT u.id, u.display_name, u.kind, u.primary_domain,
       a.primary_type, a.primary_type_conf,
       a.left_right, a.lib_auth, a.prog_cons, a.glob_nat, a.sec_rel, a.ideology_conf,
       a.political_influence, a.media_influence, a.network_centrality, a.capital_influence,
       a.is_pep, a.is_government_official
     FROM entity_profile_axes a
     JOIN u_entities u ON u.id = a.entity_id
     ${extraJoin}
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(a.political_influence, 0) DESC, u.display_name ASC
     LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql).bind(...bind, limit, offset).all();
  return c.json({ items: rows.results ?? [], meta: { limit, offset } });
});

profileRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const ent = await c.env.DB.prepare(`SELECT id, display_name, kind, primary_domain, status FROM u_entities WHERE id = ?`).bind(id).first();
  if (!ent) return c.json({ error: "entity_not_found" }, 404);
  const a = await getProfileAxes(c.env, id);
  const appointments = await c.env.DB.prepare(
    `SELECT id, title, body, jurisdiction, party, seniority, start_date, end_date, is_current, source, source_url
       FROM government_appointments WHERE entity_id = ? ORDER BY is_current DESC, COALESCE(start_date, '') DESC LIMIT 50`,
  ).bind(id).all();
  const donationsAgg = await c.env.DB.prepare(
    `SELECT recipient_party, COUNT(*) AS n, COALESCE(SUM(amount_usd), 0) AS total
       FROM political_donations WHERE entity_id = ? GROUP BY recipient_party`,
  ).bind(id).all();

  return c.json({
    entity: ent,
    classifier_version: a?.classifier_version ?? null,
    classified_at: a?.classified_at ?? null,
    refreshed_at: a?.refreshed_at ?? null,
    primary_type: a?.primary_type ?? null,
    primary_type_conf: a?.primary_type_conf ?? null,
    type_weights: parseJsonField<Record<string, number>>(a?.type_weights_json ?? null),
    ideology: a ? {
      left_right: a.left_right, lib_auth: a.lib_auth, prog_cons: a.prog_cons,
      glob_nat: a.glob_nat, sec_rel: a.sec_rel, confidence: a.ideology_conf,
    } : null,
    influence: a ? {
      network_centrality: a.network_centrality, media_influence: a.media_influence,
      capital_influence: a.capital_influence, political_influence: a.political_influence,
    } : null,
    interests: parseJsonField(a?.interests_json ?? null),
    hobbies: parseJsonField(a?.hobbies_json ?? null),
    causes: parseJsonField(a?.causes_json ?? null),
    summary: a?.summary_text ?? null,
    flags: {
      is_pep: !!a?.is_pep,
      is_government_official: !!a?.is_government_official,
      is_lobbyist: !!a?.is_lobbyist,
    },
    manual_overrides: parseJsonField(a?.manual_override_json ?? null),
    evidence_count: a?.evidence_count ?? 0,
    appointments: appointments.results ?? [],
    donations_by_party: donationsAgg.results ?? [],
  });
});

// ---------------- POST /classify/:id ----------------

profileRoute.post("/classify/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
  try {
    const r = await classifyEntity(c.env, id, { force: !!body.force });
    return c.json({ ok: true, ...r, classifier_version: CLASSIFIER_VERSION });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});

profileRoute.post("/classify/:id/dispatch", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ force?: boolean; refreshGovernment?: boolean }>().catch(() => ({} as { force?: boolean; refreshGovernment?: boolean }));
  if (!c.env.WF_CLASSIFY_ENTITY) return c.json({ ok: false, error: "workflow_not_bound" }, 503);
  const wf = await c.env.WF_CLASSIFY_ENTITY.create({ params: { entityId: id, force: !!body.force, refreshGovernment: !!body.refreshGovernment } });
  return c.json({ ok: true, workflow_id: wf.id });
});

// ---------------- POST /:id/fill (Task #3 AI Profile Filler) ----------------

profileRoute.post("/:id/fill", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
  const email = c.var.email;

  // Owner isolation (spec "Owner isolation"): manual triggers require a
  // resolved Access JWT email AND that email must be on the operator
  // allowlist. The site is single-operator today (see ADMIN_EMAILS in
  // routes/relationships.ts and the allowlist in replit.md); facts are
  // global but the trigger itself is operator-scoped so authenticated-
  // but-non-admin Access users can't burn AI spend on arbitrary IDs.
  const ADMIN_EMAILS = new Set(["guillaumelauzier@gmail.com"]);
  if (!email) {
    return c.json({ ok: false, error: "unauthenticated" }, 401);
  }
  if (!ADMIN_EMAILS.has(email.toLowerCase())) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  // Confirm the entity exists + is active before incurring any AI cost
  // or rate-limit state. (Profile facts are global per spec, but the
  // trigger itself is operator-scoped.)
  const ent = await c.env.DB.prepare(
    `SELECT id FROM u_entities WHERE id = ? AND status = 'active'`,
  ).bind(id).first<{ id: string }>().catch(() => null);
  if (!ent) return c.json({ ok: false, error: "entity_not_found" }, 404);

  // Per-(user, entity) 1 fill/min throttle so the manual endpoint can't
  // hammer Workers AI from a stuck button click.
  if (c.env.SCRAPE_CACHE) {
    const rlKey = `pf:rl:${email}:${id}`;
    const hit = await c.env.SCRAPE_CACHE.get(rlKey);
    if (hit) return c.json({ ok: false, error: "rate_limited", retry_in_seconds: 60 }, 429);
    await c.env.SCRAPE_CACHE.put(rlKey, "1", { expirationTtl: 60 });
  }

  // 7-day cap enforced even when dispatching to a workflow — Force
  // Refresh bypasses it but never the daily neuron cap.
  if (!body.force) {
    const { isWithinCooldown } = await import("../ai/profileFiller");
    const cool = await isWithinCooldown(c.env, id);
    if (cool.blocked) {
      return c.json({ ok: false, error: "cooldown_active", last_filled_at: cool.last_at, retry_with_force: true }, 429);
    }
  }

  if (c.env.WF_PROFILE_FILLER) {
    try {
      const wf = await c.env.WF_PROFILE_FILLER.create({ params: { entityId: id, force: !!body.force, triggeredBy: `manual:${email}` } });
      return c.json({ ok: true, dispatched: true, workflow_id: wf.id });
    } catch (e) {
      console.warn("WF_PROFILE_FILLER dispatch failed; falling back to inline", (e as Error).message);
    }
  }
  const { fillProfile } = await import("../ai/profileFiller");
  const r = await fillProfile(c.env, id, { force: !!body.force, triggeredBy: `manual:${email}` });
  return c.json(r);
});

// ---------------- POST /:id/refresh-government ----------------

profileRoute.post("/:id/refresh-government", async (c) => {
  const id = c.req.param("id");
  if (c.env.WF_REFRESH_GOVERNMENT) {
    const wf = await c.env.WF_REFRESH_GOVERNMENT.create({ params: { entityId: id } });
    return c.json({ ok: true, dispatched: true, workflow_id: wf.id });
  }
  const a = await refreshGovernmentAppointments(c.env, id);
  const d = await refreshDonations(c.env, id);
  return c.json({ ok: true, appointments: a, donations: d });
});

// ---------------- POST /:id/override ----------------

profileRoute.post("/:id/override", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ field?: string; value?: unknown; note?: string }>().catch(() => ({} as { field?: string; value?: unknown; note?: string }));
  if (!body.field) return c.json({ error: "field_required" }, 400);
  const allowedFields = new Set([
    "primary_type", "primary_type_conf",
    "left_right", "lib_auth", "prog_cons", "glob_nat", "sec_rel",
  ]);
  if (!allowedFields.has(body.field)) return c.json({ error: "field_not_overridable", allowed: [...allowedFields] }, 400);
  await setManualOverride(c.env, id, body.field, body.value, c.var.email, body.note);
  // Append an entity_history row so the override is auditable.
  try {
    await c.env.DB.prepare(
      `INSERT INTO entity_history (id, entity_id, action, source, changed_at, new_value)
       VALUES (?, ?, 'classify_override', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), id, c.var.email, new Date().toISOString(), JSON.stringify({ field: body.field, value: body.value, note: body.note ?? null })).run();
  } catch (e) {
    console.warn("override entity_history failed", (e as Error).message);
  }
  return c.json({ ok: true });
});

// ---------------- donations + appointments listings ----------------

profileRoute.get("/:id/donations", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "100"), 1), 500);
  const rows = await c.env.DB.prepare(
    `SELECT id, donor_name, recipient_name, recipient_party, recipient_kind, amount_usd, cycle, occurred_at, jurisdiction, source, source_url
       FROM political_donations WHERE entity_id = ? ORDER BY COALESCE(occurred_at, '') DESC LIMIT ?`,
  ).bind(id, limit).all();
  return c.json({ items: rows.results ?? [] });
});

profileRoute.post("/:id/donations", async (c) => {
  const id = c.req.param("id");
  type DonRowIn = { recipient_name: string; amount_usd?: number; cycle?: number; occurred_at?: string; recipient_party?: string; jurisdiction?: string; source_url?: string };
  const body = await c.req.json<{ rows?: DonRowIn[] }>().catch(() => ({} as { rows?: DonRowIn[] }));
  const rows = body.rows ?? [];
  if (!Array.isArray(rows) || !rows.length) return c.json({ error: "rows_required" }, 400);
  let inserted = 0;
  for (const r of rows.slice(0, 200)) {
    if (!r.recipient_name) continue;
    try {
      await c.env.DB.prepare(
        `INSERT INTO political_donations (id, entity_id, donor_name, recipient_name, recipient_party, amount_usd, cycle, occurred_at, jurisdiction, source, source_url)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'manual', ?)
         ON CONFLICT(entity_id, source, recipient_name, occurred_at, amount_usd) DO NOTHING`,
      ).bind(crypto.randomUUID(), id, r.recipient_name, r.recipient_party ?? null, r.amount_usd ?? null, r.cycle ?? null, r.occurred_at ?? null, r.jurisdiction ?? null, r.source_url ?? null).run();
      inserted++;
    } catch (e) { console.warn("manual donation insert failed", (e as Error).message); }
  }
  return c.json({ ok: true, inserted });
});

profileRoute.get("/:id/appointments", async (c) => {
  const id = c.req.param("id");
  const rows = await c.env.DB.prepare(
    `SELECT id, title, body, jurisdiction, party, seniority, start_date, end_date, is_current, source, source_url
       FROM government_appointments WHERE entity_id = ? ORDER BY is_current DESC, COALESCE(start_date, '') DESC LIMIT 200`,
  ).bind(id).all();
  return c.json({ items: rows.results ?? [] });
});

profileRoute.get("/:id/evidence", async (c) => {
  const id = c.req.param("id");
  const axis = c.req.query("axis") ?? undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
  const items = await getEvidence(c.env, id, axis, limit);
  return c.json({ items });
});
