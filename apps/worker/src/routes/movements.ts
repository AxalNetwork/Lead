// Task #2: People-at-Firms movement API.
//
//   GET  /api/movements                         — paginated movement feed
//   GET  /api/people/:entity_id/career-timeline — assembled timeline
//   GET  /api/firms/:entity_id/team-history     — every observed member
//   POST /api/movements/:id/verify              — operator override
//
// Mounted in apps/worker/src/index.ts after accessGuard. Movement data
// is platform-global; there is no per-operator owner column.

import { Hono } from "hono";
import type { Env } from "../types";

type Vars = { email: string; is_admin: boolean };

export const movementsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const peopleMovementsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const firmsMovementsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

interface MovementRow {
  id: string;
  person_entity_id: string | null;
  person_name_raw: string;
  from_firm_entity_id: string | null;
  to_firm_entity_id: string | null;
  from_title: string | null;
  to_title: string | null;
  movement_type: string;
  observed_at: string;
  source_url: string | null;
  corroborated_by_count: number;
  corroboration_sources_json: string | null;
  status: string;
}

function clampLimit(raw: string | undefined, def = 50, max = 200): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.trunc(n), max);
}

function safeJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function shapeMovement(r: MovementRow) {
  return {
    id: r.id,
    person_entity_id: r.person_entity_id,
    person_name: r.person_name_raw,
    from_firm_entity_id: r.from_firm_entity_id,
    to_firm_entity_id: r.to_firm_entity_id,
    from_title: r.from_title,
    to_title: r.to_title,
    movement_type: r.movement_type,
    observed_at: r.observed_at,
    source_url: r.source_url,
    corroborated_by_count: r.corroborated_by_count,
    corroboration_sources: safeJson<unknown[]>(r.corroboration_sources_json) ?? [],
    status: r.status,
  };
}

// ---------------- GET /api/movements ----------------
movementsRoute.get("/", async (c) => {
  const firm = c.req.query("firm");                 // firm entity_id (matches from OR to)
  const person = c.req.query("person");             // person entity_id
  const date_from = c.req.query("date_from");
  const status = c.req.query("status");
  const movement_type = c.req.query("movement_type");
  const limit = clampLimit(c.req.query("limit"));
  const rawOffset = Number(c.req.query("offset") ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (firm) {
    where.push("(from_firm_entity_id = ? OR to_firm_entity_id = ?)");
    binds.push(firm, firm);
  }
  if (person) { where.push("person_entity_id = ?"); binds.push(person); }
  if (date_from) { where.push("observed_at >= ?"); binds.push(date_from); }
  if (status) { where.push("status = ?"); binds.push(status); }
  if (movement_type) { where.push("movement_type = ?"); binds.push(movement_type); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await c.env.DB.prepare(
    `SELECT id, person_entity_id, person_name_raw, from_firm_entity_id, to_firm_entity_id,
            from_title, to_title, movement_type, observed_at, source_url,
            corroborated_by_count, corroboration_sources_json, status
       FROM partner_movements
       ${whereSql}
      ORDER BY observed_at DESC, created_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<MovementRow>();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM partner_movements ${whereSql}`,
  ).bind(...binds).first<{ n: number }>();
  return c.json({
    total: total?.n ?? 0,
    limit, offset,
    movements: (rows.results ?? []).map(shapeMovement),
  });
});

// ---------------- GET /api/people/:entity_id/career-timeline ----------------
peopleMovementsRoute.get("/:entity_id/career-timeline", async (c) => {
  const id = c.req.param("entity_id");
  const moves = await c.env.DB.prepare(
    `SELECT id, person_entity_id, person_name_raw, from_firm_entity_id, to_firm_entity_id,
            from_title, to_title, movement_type, observed_at, source_url,
            corroborated_by_count, corroboration_sources_json, status
       FROM partner_movements
      WHERE person_entity_id = ?
      ORDER BY observed_at ASC`,
  ).bind(id).all<MovementRow>();

  // LinkedIn timeline + bio segments come in via facts the LinkedIn /
  // bio adapters wrote. We surface every relevant fact alongside the
  // movements with its evidence URL — the consumer assembles the merged
  // timeline.
  // Full longitudinal timeline: include superseded (is_current=0)
  // career/title segments too, so the consumer can render the
  // person's entire trajectory — not just their current state. Each
  // segment carries its own observed_at + confidence + source so
  // stale and current rows are distinguishable.
  const facts = await c.env.DB.prepare(
    `SELECT predicate, value_text, value_number, value_json, evidence_url,
            observed_at, source, confidence, is_current
       FROM facts
      WHERE entity_id = ?
        AND predicate IN ('person.career','person.current_firm','person.current_title',
                          'person.linkedin_url','person.bio','person.past_role')
      ORDER BY observed_at ASC`,
  ).bind(id).all<{
    predicate: string;
    value_text: string | null;
    value_number: number | null;
    value_json: string | null;
    evidence_url: string | null;
    observed_at: string;
    source: string | null;
    confidence: number;
    is_current: number;
  }>();

  const segments = [
    ...(moves.results ?? []).map((m) => ({
      kind: "movement" as const,
      at: m.observed_at,
      confidence: m.status === "confirmed" ? 0.9 : 0.5,
      source_urls: [m.source_url, ...((safeJson<Array<{ url?: string }>>(m.corroboration_sources_json) ?? []).map((s) => s.url ?? null))].filter((u): u is string => !!u),
      data: shapeMovement(m),
    })),
    ...(facts.results ?? []).map((f) => ({
      kind: "fact" as const,
      at: f.observed_at,
      confidence: f.confidence,
      source_urls: f.evidence_url ? [f.evidence_url] : [],
      data: {
        predicate: f.predicate,
        value_text: f.value_text,
        value_number: f.value_number,
        value_json: safeJson<unknown>(f.value_json),
        source: f.source,
        is_current: f.is_current === 1,
      },
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return c.json({
    person_entity_id: id,
    segments,
    movement_count: moves.results?.length ?? 0,
  });
});

// ---------------- GET /api/firms/:entity_id/team-history ----------------
firmsMovementsRoute.get("/:entity_id/team-history", async (c) => {
  const id = c.req.param("entity_id");
  const snaps = await c.env.DB.prepare(
    `SELECT snapshot_date, source_url, members_json, members_count
       FROM firm_team_snapshots
      WHERE firm_entity_id = ?
      ORDER BY snapshot_date ASC`,
  ).bind(id).all<{ snapshot_date: string; source_url: string; members_json: string; members_count: number }>();

  // Build first-seen / last-seen / current per normalized name.
  interface Slot {
    name: string;
    entity_id: string | null;
    first_seen: string;
    last_seen: string;
    current: boolean;
    role_title_latest: string | null;
    profile_url_latest: string | null;
    snapshots_seen: number;
  }
  const ledger = new Map<string, Slot>();
  const allSnaps = snaps.results ?? [];
  const latestDate = allSnaps.length ? allSnaps[allSnaps.length - 1].snapshot_date : null;
  for (const s of allSnaps) {
    const members = safeJson<Array<{ name: string; entity_id?: string | null; role_title?: string | null; profile_url?: string | null }>>(s.members_json) ?? [];
    for (const m of members) {
      const nameNorm = m.name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      // Identity key: prefer the resolved entity_id (distinct same-name
      // partners stay distinct) and fall back to normalized name only
      // when the snapshotter could not resolve a canonical person.
      const key = m.entity_id ? `id:${m.entity_id}` : (nameNorm ? `n:${nameNorm}` : "");
      if (!key) continue;
      const slot = ledger.get(key);
      if (!slot) {
        ledger.set(key, {
          name: m.name,
          entity_id: m.entity_id ?? null,
          first_seen: s.snapshot_date,
          last_seen: s.snapshot_date,
          current: s.snapshot_date === latestDate,
          role_title_latest: m.role_title ?? null,
          profile_url_latest: m.profile_url ?? null,
          snapshots_seen: 1,
        });
      } else {
        slot.last_seen = s.snapshot_date;
        slot.current = s.snapshot_date === latestDate;
        slot.entity_id = slot.entity_id ?? m.entity_id ?? null;
        slot.role_title_latest = m.role_title ?? slot.role_title_latest;
        slot.profile_url_latest = m.profile_url ?? slot.profile_url_latest;
        slot.snapshots_seen += 1;
      }
    }
  }
  return c.json({
    firm_entity_id: id,
    snapshot_count: allSnaps.length,
    latest_snapshot_date: latestDate,
    members: Array.from(ledger.values()).sort((a, b) => a.first_seen.localeCompare(b.first_seen)),
  });
});

// ---------------- POST /api/movements/:id/verify ----------------
// Admin-only: operator overrides are auditable mutations and should
// never be writable by non-admin viewers, even when the access guard
// has admitted them to the read API.
movementsRoute.post("/:id/verify", async (c) => {
  if (c.var.is_admin !== true) {
    return c.json({ error: "forbidden", reason: "admin_required" }, 403);
  }
  const id = c.req.param("id");
  let body: { status?: string } = {};
  try { body = await c.req.json(); } catch { /* empty body */ }
  const next = body.status === "confirmed" || body.status === "rejected" ? body.status : null;
  if (!next) return c.json({ error: "status_required", allowed: ["confirmed", "rejected"] }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT id, status FROM partner_movements WHERE id = ?`,
  ).bind(id).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  // Audit-first ordering: write the ops_audit row BEFORE mutating
  // partner_movements. If audit logging fails, we abort the verify
  // with 500 — strict auditability requires every operator override
  // to leave a paper trail. The state change only commits when the
  // audit row exists.
  try {
    await c.env.DB.prepare(
      `INSERT INTO ops_audit (actor_email, action, target_kind, target_id, payload_json)
       VALUES (?, 'movement.verify', 'partner_movement', ?, ?)`,
    ).bind(c.var.email, id, JSON.stringify({ from: existing.status, to: next })).run();
  } catch (e) {
    const msg = (e as Error).message;
    console.warn("ops_audit insert failed", msg);
    return c.json({ error: "audit_failed", message: msg }, 500);
  }

  await c.env.DB.prepare(
    `UPDATE partner_movements SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(next, id).run();

  return c.json({
    id, status: next, previous_status: existing.status,
    audit_logged: true,
  });
});
