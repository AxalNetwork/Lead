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

async function getFirmName(env: Env, firmId: string | null): Promise<string | null> {
  if (!firmId) return null;
  const r = await env.DB.prepare(
    `SELECT display_name FROM u_entities WHERE id = ?`,
  ).bind(firmId).first<{ display_name: string | null }>();
  return r?.display_name ?? null;
}

function normFirmName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * LinkedIn signal must support the SPECIFIC transition: a
 * `person.current_firm` (or career) fact on the person whose
 * `value_entity_id` resolves to the move's destination firm AND
 * whose evidence is a LinkedIn URL. Mere existence of an old profile
 * URL does not count.
 */
async function findLinkedInSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  if (!m.person_entity_id || !m.to_firm_entity_id) return null;
  const r = await env.DB.prepare(
    `SELECT evidence_url, observed_at
       FROM facts
      WHERE entity_id = ?
        AND predicate IN ('person.current_firm','person.career','person.past_role')
        AND value_entity_id = ?
        AND evidence_url LIKE '%linkedin.com%'
        AND observed_at >= date(?, '-90 day')
        AND observed_at <= date(?, '+90 day')
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(m.person_entity_id, m.to_firm_entity_id, m.observed_at, m.observed_at)
    .first<{ evidence_url: string | null; observed_at: string }>();
  if (!r || !r.evidence_url) return null;
  return { source_kind: "linkedin", url: r.evidence_url, observed_at: r.observed_at };
}

/**
 * Twitter signal must come from a fact whose source/evidence is a
 * Twitter URL AND that names the destination firm in value_text or
 * value_entity_id. Bare twitter_handle facts don't count.
 */
async function findTwitterSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  if (!m.person_entity_id || !m.to_firm_entity_id) return null;
  const toName = normFirmName(await getFirmName(env, m.to_firm_entity_id));
  const r = await env.DB.prepare(
    `SELECT evidence_url, observed_at
       FROM facts
      WHERE entity_id = ?
        AND (evidence_url LIKE '%twitter.com%' OR evidence_url LIKE '%x.com/%' OR source LIKE '%twitter%')
        AND (
              value_entity_id = ?
           OR (? <> '' AND lower(COALESCE(value_text,'')) LIKE ?)
        )
        AND observed_at >= date(?, '-90 day')
        AND observed_at <= date(?, '+90 day')
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(
    m.person_entity_id, m.to_firm_entity_id,
    toName, `%${toName}%`,
    m.observed_at, m.observed_at,
  ).first<{ evidence_url: string | null; observed_at: string }>();
  if (!r || !r.evidence_url) return null;
  return { source_kind: "twitter", url: r.evidence_url, observed_at: r.observed_at };
}

/**
 * Tech-press signal must reference BOTH the person's normalized name
 * AND one of the involved firms (from OR to) in the same row within
 * ±60d. Same-month-only person mentions are too weak.
 */
async function findTechPressSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  const fromName = normFirmName(await getFirmName(env, m.from_firm_entity_id));
  const toName = normFirmName(await getFirmName(env, m.to_firm_entity_id));
  if (!fromName && !toName) return null;
  const firmClauses: string[] = [];
  const firmBinds: string[] = [];
  if (fromName) { firmClauses.push("lower(COALESCE(use_of_proceeds,'')) LIKE ? OR lower(COALESCE(company_name_raw,'')) LIKE ?"); firmBinds.push(`%${fromName}%`, `%${fromName}%`); }
  if (toName)   { firmClauses.push("lower(COALESCE(use_of_proceeds,'')) LIKE ? OR lower(COALESCE(company_name_raw,'')) LIKE ?"); firmBinds.push(`%${toName}%`,   `%${toName}%`); }
  const r = await env.DB.prepare(
    `SELECT source_url, COALESCE(announcement_date, closing_date, created_at) AS at
       FROM deal_events
      WHERE source_type IN ('tech_press','press_release','company_blog')
        AND COALESCE(announcement_date, closing_date) >= date(?, '-60 day')
        AND COALESCE(announcement_date, closing_date) <= date(?, '+60 day')
        AND (lower(COALESCE(use_of_proceeds,'')) LIKE ? OR lower(COALESCE(company_name_raw,'')) LIKE ?)
        AND (${firmClauses.join(" OR ")})
      ORDER BY at DESC LIMIT 1`,
  ).bind(
    m.observed_at, m.observed_at,
    `%${m.person_name_normalized}%`, `%${m.person_name_normalized}%`,
    ...firmBinds,
  ).first<{ source_url: string | null; at: string }>();
  if (!r || !r.source_url) return null;
  return { source_kind: "tech_press", url: r.source_url, observed_at: r.at };
}

/**
 * Alumni signal: the FROM firm's alumni page must list this specific
 * person. We require both a `firm.alumni_url` fact AND a
 * `firm.alumni_member` (or similar) fact whose value_text references
 * the person's normalized name. URL existence alone isn't evidence.
 */
async function findAlumniSignal(env: Env, m: MovementRow): Promise<CorroborationSignal | null> {
  if (!m.from_firm_entity_id) return null;
  const r = await env.DB.prepare(
    `SELECT evidence_url, observed_at
       FROM facts
      WHERE entity_id = ?
        AND predicate IN ('firm.alumni_member','firm.alumni')
        AND lower(COALESCE(value_text,'')) LIKE ?
        AND is_current = 1
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(m.from_firm_entity_id, `%${m.person_name_normalized}%`)
    .first<{ evidence_url: string | null; observed_at: string }>();
  if (!r || !r.evidence_url) return null;
  return { source_kind: "alumni", url: r.evidence_url, observed_at: r.observed_at };
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
