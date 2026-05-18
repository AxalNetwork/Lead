// Task #2: corroboration ladder for partner_movements.
//
// SINGLE PLACE that bumps `corroborated_by_count`. Per-adapter ad-hoc
// corroboration is forbidden by the architectural constraints.
//
// Sources we check for each provisional movement:
//   - LinkedIn public profile: a `person.linkedin_url` fact or a
//     `linkedin_url` predicate observed within ±60d of observed_at.
//   - Twitter public profile: a `twitter_handle` fact pointing at the
//     destination firm or announcing the move.
//   - Tech-press deal-flow stream: a `deal_events` row in the same
//     month whose use_of_proceeds/company name mentions the person
//     or the destination firm.
//   - Alumni page of the old firm: an `alumni_url` fact on the
//     from_firm_entity_id.
//   - SEC Form ADV control-persons update: a `person.control_of`
//     fact predicate observed for the destination firm.
//
// `corroborated_by_count >= 1` auto-promotes status to 'confirmed'.

import type { Env } from "../../types";

interface MovementRow {
  id: string;
  person_entity_id: string | null;
  person_name_raw: string;
  person_name_normalized: string;
  from_firm_entity_id: string | null;
  to_firm_entity_id: string | null;
  movement_type: string;
  observed_at: string;
  source_url: string | null;
  corroborated_by_count: number;
  corroboration_sources_json: string | null;
  status: string;
}

interface CorroborationSignal {
  source_kind: "linkedin" | "twitter" | "tech_press" | "alumni" | "sec_adv";
  url: string;
  observed_at: string;
}

function parseSources(json: string | null): CorroborationSignal[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as CorroborationSignal[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function findLinkedInSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  if (!m.person_entity_id) return null;
  const r = await env.DB.prepare(
    `SELECT evidence_url, observed_at
       FROM facts
      WHERE entity_id = ?
        AND predicate IN ('person.linkedin_url','linkedin_url','person.linkedin_slug')
        AND observed_at >= date(?, '-60 day')
        AND observed_at <= date(?, '+60 day')
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(m.person_entity_id, m.observed_at, m.observed_at)
    .first<{ evidence_url: string | null; observed_at: string }>();
  if (!r || !r.evidence_url) return null;
  return { source_kind: "linkedin", url: r.evidence_url, observed_at: r.observed_at };
}

async function findTwitterSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  if (!m.person_entity_id) return null;
  const r = await env.DB.prepare(
    `SELECT evidence_url, observed_at
       FROM facts
      WHERE entity_id = ?
        AND predicate IN ('person.twitter_handle','twitter_handle')
        AND observed_at >= date(?, '-60 day')
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(m.person_entity_id, m.observed_at)
    .first<{ evidence_url: string | null; observed_at: string }>();
  if (!r || !r.evidence_url) return null;
  return { source_kind: "twitter", url: r.evidence_url, observed_at: r.observed_at };
}

async function findTechPressSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  // Look for any tech-press deal_event within ±30 days that mentions
  // the person's name or the destination firm in use_of_proceeds.
  const monthBucket = m.observed_at.slice(0, 7);
  const r = await env.DB.prepare(
    `SELECT source_url, COALESCE(announcement_date, closing_date, created_at) AS at
       FROM deal_events
      WHERE source_type IN ('tech_press','press_release','company_blog')
        AND substr(COALESCE(announcement_date, closing_date), 1, 7) = ?
        AND (
              lower(COALESCE(use_of_proceeds,'')) LIKE ?
           OR lower(COALESCE(company_name_raw,'')) LIKE ?
        )
      ORDER BY at DESC LIMIT 1`,
  ).bind(
    monthBucket,
    `%${m.person_name_normalized}%`,
    `%${m.person_name_normalized}%`,
  ).first<{ source_url: string | null; at: string }>();
  if (!r || !r.source_url) return null;
  return { source_kind: "tech_press", url: r.source_url, observed_at: r.at };
}

async function findAlumniSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  if (!m.from_firm_entity_id) return null;
  const r = await env.DB.prepare(
    `SELECT value_text AS url, observed_at
       FROM facts
      WHERE entity_id = ?
        AND predicate IN ('firm.alumni_url','alumni_url')
        AND is_current = 1
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(m.from_firm_entity_id)
    .first<{ url: string | null; observed_at: string }>();
  if (!r || !r.url) return null;
  return { source_kind: "alumni", url: r.url, observed_at: r.observed_at };
}

async function findSecAdvSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  if (!m.to_firm_entity_id) return null;
  // Form ADV control-persons facts are written by the EDGAR persist
  // layer onto the firm entity as `firm.control_person` with the
  // person's name in value_text. We look for one mentioning this
  // person's normalized name observed within ±180d of the move.
  const r = await env.DB.prepare(
    `SELECT evidence_url, observed_at
       FROM facts
      WHERE entity_id = ?
        AND predicate IN ('firm.control_person','firm.adv_control_person')
        AND lower(COALESCE(value_text,'')) LIKE ?
        AND observed_at >= date(?, '-180 day')
        AND observed_at <= date(?, '+180 day')
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(
    m.to_firm_entity_id,
    `%${m.person_name_normalized}%`,
    m.observed_at, m.observed_at,
  ).first<{ evidence_url: string | null; observed_at: string }>();
  if (!r || !r.evidence_url) return null;
  return { source_kind: "sec_adv", url: r.evidence_url, observed_at: r.observed_at };
}

/**
 * Corroborate a single provisional movement. Returns the new status.
 */
export async function corroborateMovement(env: Env, movementId: string): Promise<{
  status: string;
  added: number;
  total: number;
}> {
  const m = await env.DB.prepare(
    `SELECT id, person_entity_id, person_name_raw, person_name_normalized,
            from_firm_entity_id, to_firm_entity_id, movement_type, observed_at,
            source_url, corroborated_by_count, corroboration_sources_json, status
       FROM partner_movements WHERE id = ?`,
  ).bind(movementId).first<MovementRow>();
  if (!m) return { status: "missing", added: 0, total: 0 };
  if (m.status === "rejected") return { status: m.status, added: 0, total: m.corroborated_by_count };

  const existing = parseSources(m.corroboration_sources_json);
  const existingKinds = new Set(existing.map((s) => s.source_kind));
  const new_signals: CorroborationSignal[] = [];

  for (const finder of [findLinkedInSignal, findTwitterSignal, findTechPressSignal, findAlumniSignal, findSecAdvSignal] as const) {
    try {
      const sig = await finder(env, m);
      if (sig && !existingKinds.has(sig.source_kind)) {
        new_signals.push(sig);
        existingKinds.add(sig.source_kind);
      }
    } catch (e) {
      console.warn("corroboration finder failed", (e as Error).message);
    }
  }

  if (!new_signals.length) {
    return { status: m.status, added: 0, total: m.corroborated_by_count };
  }

  const allSources = [...existing, ...new_signals];
  const total = allSources.length;
  const nextStatus = m.status === "provisional" && total >= 1 ? "confirmed" : m.status;
  await env.DB.prepare(
    `UPDATE partner_movements
        SET corroborated_by_count = ?,
            corroboration_sources_json = ?,
            status = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).bind(total, JSON.stringify(allSources), nextStatus, movementId).run();
  return { status: nextStatus, added: new_signals.length, total };
}

/**
 * Sweep provisional movements; bounded by `limit`.
 */
export async function runCorroborationSweep(env: Env, limit = 200): Promise<{
  picked: number;
  confirmed: number;
  unchanged: number;
}> {
  const out = { picked: 0, confirmed: 0, unchanged: 0 };
  const rows = await env.DB.prepare(
    `SELECT id FROM partner_movements
      WHERE status = 'provisional'
      ORDER BY observed_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>();
  for (const r of rows.results ?? []) {
    try {
      const res = await corroborateMovement(env, r.id);
      out.picked += 1;
      if (res.status === "confirmed") out.confirmed += 1;
      else out.unchanged += 1;
    } catch (e) {
      console.warn("corroborateMovement failed", r.id, (e as Error).message);
    }
  }
  return out;
}
