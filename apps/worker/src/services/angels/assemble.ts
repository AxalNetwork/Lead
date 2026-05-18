// Task #4: Angel assembler.
//
// Builds or refreshes one `angels` row by combining every available
// signal for a person entity:
//   1. deal_participants — disclosed investments (when investor_entity_id
//      resolves to a person entity)
//   2. person.career current row — day-job firm + role
//   3. facts: person.syndicate_handle, person.rolling_fund_handle,
//      person.open_to_warm_intros (when adapters have written them)
//   4. AngelList / SPV Form D / Crunchbase signals (via the same fact
//      graph — adapters land them; this service consumes them)
//
// Investment dedupe collapses on the deal-aggregator's `dealDedupeKey`
// (sha256(normalized_company|event_type|round|month)) so an SPV Form D
// filing + a press release for the same round produce one row per
// (angel, deal).
//
// All entity-level facts (person.is_angel, person.angel_day_job,
// person.angel_domain_expertise, person.angel_type) flow through
// canonical `insertFact` per the Task #1 contract.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { dealDedupeKey } from "../deals/dedupe";
import { classifyAngel, statsFromInvestments } from "./classifier";
import { deriveDomainExpertise } from "./operatorExpertise";
import {
  ANGEL_AUTHORITY,
  type AngelEvidence, type AngelInvestmentRow,
  type AngelSourceType, type AngelType,
} from "./types";

export interface AssembleAngelResult {
  person_entity_id: string;
  created: boolean;
  angel_type: AngelType | null;
  classifier_confidence: number | null;
  disclosed_investments_count: number;
  domain_expertise_tags: string[];
  refreshed_at: string;
}

interface DealParticipantRow {
  deal_id: string;
  role: string;
  position_usd: number | null;
  source_url: string | null;
  source_type: string | null;
  company_entity_id: string | null;
  company_name_raw: string;
  amount_usd: number | null;
  round_name: string | null;
  announcement_date: string | null;
  event_type: string;
  sector_tags_json: string | null;
  geography: string | null;
  deal_source_url: string | null;
  deal_source_type: string | null;
}

function safeArr(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  } catch { /* ignore */ }
  return [];
}

function normalizeSourceType(raw: string | null | undefined): AngelSourceType {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("sec") || s.includes("filing") || s.includes("form_d") || s.includes("edgar")) return "sec_filing";
  if (s.includes("company_blog") || s.includes("company-blog")) return "company_blog";
  if (s.includes("angellist") || s.includes("angel.co")) return "angellist";
  if (s.includes("crunchbase")) return "crunchbase";
  // tech-press hosts must be matched BEFORE the generic `press` check,
  // otherwise techcrunch/axios records degrade to plain press_release
  // and lose their (correct) source-authority rank.
  if (s.includes("tech_press") || s.includes("techcrunch") || s.includes("axios") || s.includes("theinformation") || s.includes("verge")) return "tech_press";
  if (s.includes("press")) return "press_release";
  if (s.includes("twitter") || s.includes("social")) return "social_bio";
  if (s.includes("newsletter") || s.includes("substack")) return "newsletter";
  return "press_release";
}

/** Sort evidence rows highest-authority first so downstream UIs / pickers
 *  can take `evidence[0]` as the canonical source. */
function sortEvidenceByAuthority(rows: AngelEvidence[]): AngelEvidence[] {
  return rows.slice().sort((a, b) => {
    const ra = ANGEL_AUTHORITY[a.source_type] ?? 0;
    const rb = ANGEL_AUTHORITY[b.source_type] ?? 0;
    if (ra !== rb) return rb - ra;
    return (b.observed_at ?? "").localeCompare(a.observed_at ?? "");
  });
}

/** Pick a single best (value, source_url) for a field from a candidate
 *  set, using the SEC > company > press > tech-press > social hierarchy. */
function pickByAuthority<T>(candidates: Array<{ value: T | null | undefined; source_type: AngelSourceType; source_url: string | null }>): { value: T | null; source_url: string | null; source_type: AngelSourceType | null } {
  let best: { value: T | null; source_url: string | null; source_type: AngelSourceType | null; rank: number } = { value: null, source_url: null, source_type: null, rank: -1 };
  for (const c of candidates) {
    if (c.value == null) continue;
    const rank = ANGEL_AUTHORITY[c.source_type] ?? 0;
    if (rank > best.rank) best = { value: c.value, source_url: c.source_url, source_type: c.source_type, rank };
  }
  return { value: best.value, source_url: best.source_url, source_type: best.source_type };
}

function mapRole(raw: string | null | undefined): "lead" | "participant" | "follow_on" {
  const r = (raw ?? "").toLowerCase();
  if (r === "lead") return "lead";
  if (r === "follow_on" || r === "follow-on") return "follow_on";
  return "participant";
}

/** Load the latest current career row to identify day-job firm/role. */
async function loadDayJob(env: Env, personEntityId: string): Promise<{
  day_job_entity_id: string | null;
  day_job_role: string | null;
  day_job_evidence_url: string | null;
  is_ex_founder: boolean;
}> {
  const cur = await env.DB.prepare(
    `SELECT organization_entity_id, role_title, source_url
       FROM career_history
      WHERE entity_id = ? AND is_current = 1
      ORDER BY COALESCE(started_at, '') DESC
      LIMIT 1`,
  ).bind(personEntityId).first<{
    organization_entity_id: string | null;
    role_title: string | null;
    source_url: string | null;
  }>();
  // Ex-founder: any past role containing founder
  const past = await env.DB.prepare(
    `SELECT 1 AS x FROM career_history
      WHERE entity_id = ? AND LOWER(COALESCE(role_title,'')) LIKE '%founder%'
      LIMIT 1`,
  ).bind(personEntityId).first<{ x: number }>();
  return {
    day_job_entity_id: cur?.organization_entity_id ?? null,
    day_job_role: cur?.role_title ?? null,
    day_job_evidence_url: cur?.source_url ?? null,
    is_ex_founder: !!past,
  };
}

/** Does the firm have any tech-flavored sector tag in `facts`? */
async function isTechFirm(env: Env, firmEntityId: string | null): Promise<boolean> {
  if (!firmEntityId) return false;
  const r = await env.DB.prepare(
    `SELECT value_text, value_json FROM facts
      WHERE entity_id = ?
        AND predicate IN ('sector','industry','firm.sector','firm.industry','firm.sectors','sectors')
        AND is_current = 1
      LIMIT 50`,
  ).bind(firmEntityId).all<{ value_text: string | null; value_json: string | null }>();
  const re = /\b(tech|software|saas|fintech|payments|ai\b|ml\b|crypto|web3|dev[\s_-]?tools|infra|security|cyber|health|biotech|medtech|consumer|d2c|marketplace|commerce|media|api|platform)\b/i;
  for (const row of r.results ?? []) {
    if (row.value_text && re.test(row.value_text)) return true;
    if (row.value_json && re.test(row.value_json)) return true;
  }
  return false;
}

/** Read fact value_text for a single predicate (latest current row only).
 *  Use for boolean/freshness signals where authority arbitration is N/A. */
async function loadFactText(env: Env, entityId: string, predicate: string): Promise<{ value: string | null; source: string | null }> {
  const r = await env.DB.prepare(
    `SELECT value_text, source FROM facts
      WHERE entity_id = ? AND predicate = ? AND is_current = 1
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(entityId, predicate).first<{ value_text: string | null; source: string | null }>();
  return { value: r?.value_text ?? null, source: r?.source ?? null };
}

/** Load every CURRENT candidate for a predicate so pickByAuthority can
 *  arbitrate across competing sources. Without this, the latest-observed
 *  row wins by recency before the SEC > company > press > tech > social
 *  hierarchy ever runs (the Task #1 source-authority contract).
 *  Bounded at 50 candidates per predicate — angel facts are sparse. */
async function loadFactCandidates(
  env: Env, entityId: string, predicate: string,
): Promise<Array<{ value: string | null; source: string | null }>> {
  const r = await env.DB.prepare(
    `SELECT value_text, source FROM facts
      WHERE entity_id = ? AND predicate = ? AND is_current = 1
      ORDER BY observed_at DESC LIMIT 50`,
  ).bind(entityId, predicate).all<{ value_text: string | null; source: string | null }>();
  return (r.results ?? []).map((row) => ({ value: row.value_text, source: row.source }));
}

/** Resolve participant rows for one person into normalized investment rows. */
async function loadInvestments(env: Env, personEntityId: string): Promise<AngelInvestmentRow[]> {
  const res = await env.DB.prepare(
    `SELECT p.deal_id, p.role, p.position_usd, p.source_url, p.source_type,
            d.company_entity_id, d.company_name_raw, d.amount_usd, d.round_name,
            d.announcement_date, d.event_type, d.sector_tags_json, d.geography,
            d.source_url AS deal_source_url, d.source_type AS deal_source_type
       FROM deal_participants p
       JOIN deal_events d ON d.id = p.deal_id
      WHERE p.investor_entity_id = ?
      ORDER BY d.announcement_date DESC NULLS LAST
      LIMIT 2000`,
  ).bind(personEntityId).all<DealParticipantRow>();
  const out: AngelInvestmentRow[] = [];
  for (const r of res.results ?? []) {
    const key = await dealDedupeKey({
      company_name_raw: r.company_name_raw,
      event_type: r.event_type,
      round_name: r.round_name,
      announcement_date: r.announcement_date,
      closing_date: null,
    });
    if (!key) continue;
    out.push({
      id: crypto.randomUUID(),
      person_entity_id: personEntityId,
      company_entity_id: r.company_entity_id,
      company_name_raw: r.company_name_raw,
      amount_usd: r.position_usd ?? null,
      round_name: r.round_name,
      role: mapRole(r.role),
      via_syndicate_handle: null,
      announced_at: r.announcement_date,
      observed_at: new Date().toISOString(),
      source_url: r.source_url ?? r.deal_source_url,
      source_type: normalizeSourceType(r.source_type ?? r.deal_source_type),
      dedupe_key: key,
      deal_event_id: r.deal_id,
      confidence: 0.7,
    });
  }
  return out;
}

/** Upsert angel_investments rows; dedupe on (person, dedupe_key). */
async function persistInvestments(env: Env, rows: AngelInvestmentRow[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    try {
      await env.DB.prepare(
        `INSERT INTO angel_investments (
           id, person_entity_id, company_entity_id, company_name_raw,
           amount_usd, round_name, role, via_syndicate_handle,
           announced_at, observed_at, source_url, source_type,
           dedupe_key, deal_event_id, confidence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(person_entity_id, dedupe_key) DO UPDATE SET
           company_entity_id = COALESCE(excluded.company_entity_id, angel_investments.company_entity_id),
           amount_usd        = COALESCE(excluded.amount_usd, angel_investments.amount_usd),
           role              = excluded.role,
           via_syndicate_handle = COALESCE(excluded.via_syndicate_handle, angel_investments.via_syndicate_handle),
           source_url        = COALESCE(excluded.source_url, angel_investments.source_url),
           source_type       = COALESCE(excluded.source_type, angel_investments.source_type),
           deal_event_id     = COALESCE(excluded.deal_event_id, angel_investments.deal_event_id),
           confidence        = MAX(excluded.confidence, angel_investments.confidence),
           observed_at       = excluded.observed_at`,
      ).bind(
        r.id, r.person_entity_id, r.company_entity_id, r.company_name_raw,
        r.amount_usd, r.round_name, r.role, r.via_syndicate_handle,
        r.announced_at, r.observed_at, r.source_url, r.source_type,
        r.dedupe_key, r.deal_event_id, r.confidence,
      ).run();
      n++;
    } catch (e) {
      console.warn("angel_investments upsert failed", (e as Error).message);
    }
  }
  return n;
}

/** Derive typical check band from disclosed amounts: p20 / p80. */
function checkBand(rows: AngelInvestmentRow[]): { min: number | null; max: number | null } {
  const amounts = rows.map((r) => r.amount_usd).filter((n): n is number => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
  if (amounts.length === 0) return { min: null, max: null };
  const p20 = amounts[Math.floor(amounts.length * 0.20)];
  const p80 = amounts[Math.min(amounts.length - 1, Math.floor(amounts.length * 0.80))];
  return { min: p20, max: p80 };
}

function uniq<T>(arr: T[]): T[] { return [...new Set(arr)]; }

export async function assembleAngel(
  env: Env, personEntityId: string,
): Promise<AssembleAngelResult> {
  const now = new Date().toISOString();
  const evidence: AngelEvidence[] = [];

  // --- Inputs ---------------------------------------------------------
  const dayJob = await loadDayJob(env, personEntityId);
  const dayJobTechFlag = await isTechFirm(env, dayJob.day_job_entity_id);
  const investments = await loadInvestments(env, personEntityId);

  // Load ALL current candidates for handle facts so pickByAuthority can
  // arbitrate across competing sources (SEC > company > press > tech >
  // social). warmFact is a boolean; latest-current is sufficient.
  const syndicateCandidates = await loadFactCandidates(env, personEntityId, "person.syndicate_handle");
  const rollingCandidates   = await loadFactCandidates(env, personEntityId, "person.rolling_fund_handle");
  const warmFact            = await loadFactText(env, personEntityId, "person.open_to_warm_intros");
  // Pre-compute the authority-arbitrated values so downstream stamping
  // (SPV mini-adapter, investment via_syndicate_handle backfill) uses
  // the canonical pick rather than whatever happened to be observed
  // most recently.
  const syndPick = pickByAuthority<string>(
    syndicateCandidates.map((c) => ({
      value: c.value, source_type: normalizeSourceType(c.source), source_url: c.source,
    })),
  );
  const rollingPick = pickByAuthority<string>(
    rollingCandidates.map((c) => ({
      value: c.value, source_type: normalizeSourceType(c.source), source_url: c.source,
    })),
  );
  const syndicateFact = { value: syndPick.value };
  const rollingFact   = { value: rollingPick.value };

  // Stamp via_syndicate_handle on any investment where this angel is
  // recorded as the lead and is a syndicate_lead — without this, the
  // syndicate analytics service can never populate deals_count /
  // velocity / last_deal_at for handles known only via facts.
  if (syndicateFact.value) {
    for (const inv of investments) {
      if (inv.role === "lead" && !inv.via_syndicate_handle) {
        inv.via_syndicate_handle = syndicateFact.value;
      }
    }
  }

  // Form D SPV mini-adapter: an SPV is a single-LLC angel vehicle
  // whose issuer_name matches a syndicate naming pattern. We look up
  // Form D filings where this person appears in related_persons, then
  // (a) stamp via_syndicate_handle on matching angel_investments, and
  // (b) record each named individual as a syndicate_backer.
  await ingestFormDSpvSignals(env, personEntityId, investments, syndicateFact.value);

  // Persist investments AFTER via_syndicate_handle has been stamped by
  // both the syndicate-fact pass and the Form D SPV mini-adapter.
  await persistInvestments(env, investments);

  const stats = statsFromInvestments(investments);
  const band = checkBand(investments);

  // --- Sectors / geos / stages from investment data ------------------
  const sectors: string[] = [];
  const geos: string[] = [];
  const stages: string[] = [];
  for (const r of investments) {
    if (r.round_name) stages.push(r.round_name);
  }
  // Pull sector/geography from deal_events via the row IDs (already loaded above)
  if (investments.length > 0) {
    const ids = investments.map((r) => r.deal_event_id).filter((x): x is string => !!x);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const r = await env.DB.prepare(
        `SELECT sector_tags_json, geography FROM deal_events WHERE id IN (${placeholders})`,
      ).bind(...ids).all<{ sector_tags_json: string | null; geography: string | null }>();
      for (const x of r.results ?? []) {
        for (const s of safeArr(x.sector_tags_json)) sectors.push(s);
        if (x.geography) geos.push(x.geography);
      }
    }
  }

  const expertise = await deriveDomainExpertise(env, {
    dayJobEntityId: dayJob.day_job_entity_id,
    dayJobRole: dayJob.day_job_role,
    investmentSectors: sectors,
  });

  const classifier = classifyAngel({
    disclosed_investments_count: investments.length,
    lead_count: stats.lead_count,
    median_check_usd: stats.median_check_usd,
    annualized_deployed_usd: stats.annualized_deployed_usd,
    day_job_role: dayJob.day_job_role,
    day_job_is_tech_firm: dayJobTechFlag,
    syndicate_handle: syndicateFact.value,
    rolling_fund_handle: rollingFact.value,
    is_ex_founder: dayJob.is_ex_founder,
  });

  if (dayJob.day_job_entity_id) {
    evidence.push({ field: "day_job", value: dayJob.day_job_entity_id,
      source_type: normalizeSourceType(dayJob.day_job_evidence_url),
      source_url: dayJob.day_job_evidence_url, observed_at: now });
  }
  for (const inv of investments.slice(0, 10)) {
    evidence.push({ field: "investment", value: { company: inv.company_name_raw, round: inv.round_name },
      source_type: inv.source_type ?? "press_release",
      source_url: inv.source_url, observed_at: inv.observed_at });
  }

  // --- Per-field source-authority picks ------------------------------
  // syndPick / rollingPick were arbitrated above across ALL current
  // candidates so downstream stamping uses the canonical value. day_job
  // comes from `career_history` (a structured row, not `facts`), so a
  // single-candidate pick is correct here.
  const dayJobPick = pickByAuthority<string>([
    { value: dayJob.day_job_entity_id, source_type: normalizeSourceType(dayJob.day_job_evidence_url), source_url: dayJob.day_job_evidence_url },
  ]);

  // --- Persist angels row --------------------------------------------
  const evidenceJson = JSON.stringify(sortEvidenceByAuthority(evidence));
  const expertiseJson = expertise.length > 0 ? JSON.stringify(expertise) : null;
  const sectorsJson = sectors.length > 0 ? JSON.stringify(uniq(sectors).slice(0, 20)) : null;
  const geosJson    = geos.length > 0 ? JSON.stringify(uniq(geos).slice(0, 20)) : null;
  const stagesJson  = stages.length > 0 ? JSON.stringify(uniq(stages).slice(0, 20)) : null;

  const existing = await env.DB.prepare(
    `SELECT person_entity_id FROM angels WHERE person_entity_id = ?`,
  ).bind(personEntityId).first<{ person_entity_id: string }>();

  await env.DB.prepare(
    `INSERT INTO angels (
       person_entity_id, angel_type, classifier_confidence,
       day_job_entity_id, day_job_role,
       typical_check_min_usd, typical_check_max_usd,
       preferred_stages_json, preferred_sectors_json, preferred_geos_json,
       portfolio_count, disclosed_investments_count,
       syndicate_handle, rolling_fund_handle, domain_expertise_tags_json,
       last_investment_at, open_to_warm_intros, source_evidence_json,
       confidence, updated_at, created_at, last_refreshed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(person_entity_id) DO UPDATE SET
       angel_type             = excluded.angel_type,
       classifier_confidence  = excluded.classifier_confidence,
       day_job_entity_id      = COALESCE(excluded.day_job_entity_id, angels.day_job_entity_id),
       day_job_role           = COALESCE(excluded.day_job_role, angels.day_job_role),
       typical_check_min_usd  = excluded.typical_check_min_usd,
       typical_check_max_usd  = excluded.typical_check_max_usd,
       preferred_stages_json  = excluded.preferred_stages_json,
       preferred_sectors_json = excluded.preferred_sectors_json,
       preferred_geos_json    = excluded.preferred_geos_json,
       portfolio_count        = excluded.portfolio_count,
       disclosed_investments_count = excluded.disclosed_investments_count,
       syndicate_handle       = COALESCE(excluded.syndicate_handle, angels.syndicate_handle),
       rolling_fund_handle    = COALESCE(excluded.rolling_fund_handle, angels.rolling_fund_handle),
       domain_expertise_tags_json = excluded.domain_expertise_tags_json,
       last_investment_at     = excluded.last_investment_at,
       open_to_warm_intros    = excluded.open_to_warm_intros,
       source_evidence_json   = excluded.source_evidence_json,
       confidence             = MAX(excluded.confidence, angels.confidence),
       updated_at             = excluded.updated_at,
       last_refreshed_at      = excluded.last_refreshed_at`,
  ).bind(
    personEntityId, classifier.angel_type, classifier.confidence,
    dayJobPick.value, dayJob.day_job_role,
    band.min, band.max,
    stagesJson, sectorsJson, geosJson,
    investments.length, investments.length,
    syndPick.value, rollingPick.value, expertiseJson,
    stats.last_investment_at,
    warmFact.value && /^(1|true|yes)$/i.test(warmFact.value) ? 1 : 0,
    evidenceJson,
    Math.min(0.95, 0.4 + Math.min(0.5, investments.length / 100)),
    now, now, now,
  ).run();

  // --- Canonical entity facts via insertFact -------------------------
  const source = "angel_assembler";
  const sortedEvidence = sortEvidenceByAuthority(evidence);
  await insertFact(env, {
    entity_id: personEntityId, predicate: "person.is_angel",
    value_text: "true", source_kind: "enrichment", source,
    evidence_url: sortedEvidence[0]?.source_url ?? null, confidence: classifier.confidence,
  });
  if (classifier.angel_type) {
    await insertFact(env, {
      entity_id: personEntityId, predicate: "person.angel_type",
      value_text: classifier.angel_type, source_kind: "enrichment", source,
      confidence: classifier.confidence,
    });
  }
  if (dayJob.day_job_entity_id) {
    await insertFact(env, {
      entity_id: personEntityId, predicate: "person.angel_day_job",
      value_entity_id: dayJob.day_job_entity_id, source_kind: "enrichment", source,
      evidence_url: dayJob.day_job_evidence_url, confidence: 0.8,
    });
  }
  if (expertise.length > 0) {
    await insertFact(env, {
      entity_id: personEntityId, predicate: "person.angel_domain_expertise",
      value_json: expertise, source_kind: "enrichment", source,
      confidence: 0.75,
    });
  }

  // --- Syndicate handle stamping -------------------------------------
  if (syndPick.value) {
    await env.DB.prepare(
      `INSERT INTO syndicates (handle, display_name, lead_angel_entity_id,
                               focus_sectors_json, focus_stages_json, geos_json,
                               backer_count, deals_count, last_deal_at,
                               avg_raise_usd, median_check_usd, velocity_per_quarter,
                               source_evidence_json, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         lead_angel_entity_id = COALESCE(syndicates.lead_angel_entity_id, excluded.lead_angel_entity_id),
         focus_sectors_json   = COALESCE(syndicates.focus_sectors_json, excluded.focus_sectors_json),
         focus_stages_json    = COALESCE(syndicates.focus_stages_json, excluded.focus_stages_json),
         geos_json            = COALESCE(syndicates.geos_json, excluded.geos_json),
         updated_at           = excluded.updated_at`,
    ).bind(
      syndPick.value, syndPick.value, personEntityId,
      sectorsJson, stagesJson, geosJson,
      now, now,
    ).run();
  }

  return {
    person_entity_id: personEntityId,
    created: !existing,
    angel_type: classifier.angel_type,
    classifier_confidence: classifier.confidence,
    disclosed_investments_count: investments.length,
    domain_expertise_tags: expertise.map((e) => e.tag),
    refreshed_at: now,
  };
}

/** Form D SPV mini-adapter — scans `sec_form_d_rounds` for filings that
 *  name this person in `related_persons_json` and whose `issuer_name`
 *  matches an angel-SPV naming pattern (e.g. "X Syndicate LLC",
 *  "X Angels SPV", "X Capital LLC – Series N"). For each match:
 *
 *   - Slugifies the syndicate name into a handle (or reuses the
 *     person's known `person.syndicate_handle` when set).
 *   - Stamps `via_syndicate_handle` on any in-memory investment row
 *     whose announcement_date falls within ~120 days of the filing,
 *     bridging the SPV → press-release linkage that adapters would
 *     otherwise have to produce explicitly.
 *   - Records every named `related_person` (other than the angel) as a
 *     row in `syndicate_backers`, so the `syndicate_overlap` view has
 *     real data to join on.
 */
async function ingestFormDSpvSignals(
  env: Env,
  personEntityId: string,
  investments: AngelInvestmentRow[],
  knownHandle: string | null,
): Promise<void> {
  // Pull the person's display name to match against related_persons_json.
  const pers = await env.DB.prepare(
    `SELECT display_name FROM u_entities WHERE id = ?`,
  ).bind(personEntityId).first<{ display_name: string | null }>();
  const personName = (pers?.display_name ?? "").trim().toLowerCase();
  if (!personName) return;

  const res = await env.DB.prepare(
    `SELECT id, issuer_name, related_persons_json, date_of_first_sale, accession_no
       FROM sec_form_d_rounds
      WHERE lower(related_persons_json) LIKE ?
      ORDER BY date_of_first_sale DESC NULLS LAST
      LIMIT 100`,
  ).bind(`%${personName}%`).all<{
    id: string; issuer_name: string; related_persons_json: string;
    date_of_first_sale: string | null; accession_no: string;
  }>();

  const SPV_RE = /\b(syndicate|angels?\s+spv|spv|series\s+[a-z0-9]+|special\s+purpose)\b/i;
  const now = new Date().toISOString();

  for (const row of res.results ?? []) {
    if (!SPV_RE.test(row.issuer_name)) continue;
    let related: Array<{ name?: string; role?: string }> = [];
    try { related = JSON.parse(row.related_persons_json ?? "[]"); } catch { /* ignore */ }
    const namedHere = related.some((r) => typeof r?.name === "string" && r.name.toLowerCase().includes(personName));
    if (!namedHere) continue;

    // Derive a handle: prefer the angel's known one; else slugify issuer.
    const handle = knownHandle ?? row.issuer_name.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 60);
    if (!handle) continue;

    const filed = row.date_of_first_sale;
    if (filed) {
      const filedTs = Date.parse(filed);
      for (const inv of investments) {
        if (inv.via_syndicate_handle) continue;
        if (!inv.announced_at) continue;
        const invTs = Date.parse(inv.announced_at);
        if (Number.isNaN(filedTs) || Number.isNaN(invTs)) continue;
        if (Math.abs(invTs - filedTs) <= 120 * 24 * 3600 * 1000) {
          inv.via_syndicate_handle = handle;
        }
      }
    }

    // Record co-backers (anyone named in related_persons other than the angel).
    for (const r of related) {
      const nm = typeof r?.name === "string" ? r.name.trim() : "";
      if (!nm || nm.toLowerCase() === personName) continue;
      // Try to resolve to an existing person entity; if none, use the raw
      // name as a stable surrogate id (`raw:<lowercased-name>`) so the
      // overlap view still joins on a deterministic backer key.
      const ent = await env.DB.prepare(
        `SELECT id FROM u_entities WHERE kind = 'person' AND lower(display_name) = ? LIMIT 1`,
      ).bind(nm.toLowerCase()).first<{ id: string }>();
      const backerId = ent?.id ?? `raw:${nm.toLowerCase()}`;
      try {
        await env.DB.prepare(
          `INSERT INTO syndicate_backers (syndicate_handle, backer_entity_id, backer_name_raw, source_url, observed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(syndicate_handle, backer_entity_id) DO UPDATE SET
             backer_name_raw = COALESCE(excluded.backer_name_raw, syndicate_backers.backer_name_raw),
             observed_at     = excluded.observed_at`,
        ).bind(handle, backerId, nm, null, now).run();
      } catch (e) {
        console.warn("syndicate_backers upsert failed", handle, (e as Error).message);
      }
    }

    // Also create / touch the syndicate row so the analytics rebuild has
    // a handle to compute against, even if no fact stamping happened.
    try {
      await env.DB.prepare(
        `INSERT INTO syndicates (handle, display_name, lead_angel_entity_id,
                                 focus_sectors_json, focus_stages_json, geos_json,
                                 backer_count, deals_count, last_deal_at,
                                 avg_raise_usd, median_check_usd, velocity_per_quarter,
                                 source_evidence_json, updated_at, created_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET
           lead_angel_entity_id = COALESCE(syndicates.lead_angel_entity_id, excluded.lead_angel_entity_id),
           display_name         = COALESCE(syndicates.display_name, excluded.display_name),
           updated_at           = excluded.updated_at`,
      ).bind(handle, row.issuer_name, personEntityId, now, now).run();
    } catch (e) {
      console.warn("syndicates touch failed", handle, (e as Error).message);
    }
  }
}

/** Walk every person entity that has been observed as a deal participant
 *  (investor_entity_id) and refresh the angels row. Bounded by `limit`. */
export async function refreshAllAngels(env: Env, limit = 500): Promise<number> {
  const res = await env.DB.prepare(
    `SELECT DISTINCT p.investor_entity_id AS id
       FROM deal_participants p
       JOIN u_entities u ON u.id = p.investor_entity_id
      WHERE p.investor_entity_id IS NOT NULL
        AND u.kind = 'person'
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>();
  let n = 0;
  for (const r of res.results ?? []) {
    try { await assembleAngel(env, r.id); n++; }
    catch (e) { console.warn("assembleAngel failed", r.id, (e as Error).message); }
  }
  return n;
}

