// Task #3: Deal persist layer.
//
// Single writer for `deal_events` / `deal_participants` and the only
// place that:
//   - computes the dedupe_key (via services/deals/dedupe.ts)
//   - escalates status provisional → corroborated on N≥2 distinct
//     source URLs, or → disputed on hard-field conflict
//   - picks per-field canonical values by source-authority hierarchy
//   - resolves company + investor entities through the canonical
//     createEntity / addRole / insertFact path
//   - synthesizes deal_events from already-persisted SEC filings
//     (Form D, Form 8-K Item 1.01/2.01) — never re-fetches.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { createEntity, addRole } from "../../entities/roles";
import { resolveInvestor } from "./investorResolver";
import {
  dealDedupeKey, hasHardConflict, isHigherAuthority, normalizeCompanyName,
} from "./dedupe";
import type {
  DealCandidate, DealEventType, DealSourceType,
} from "./types";
import type { FormDPayload, Form8KPayload, FilingHeader } from "../../crawler/adapters/secEdgar";

const MIN_PERSIST_CONFIDENCE = 0.2;

export interface DealPersistResult {
  deal_id: string | null;
  status: "provisional" | "corroborated" | "disputed";
  was_new: boolean;
  skipped: boolean;
  reason?: string;
  dedupe_key: string | null;
}

interface ExistingDealRow {
  id: string;
  event_type: string;
  company_entity_id: string | null;
  company_name_raw: string;
  round_name: string | null;
  amount_usd: number | null;
  amount_raw: string | null;
  valuation_usd: number | null;
  valuation_type: string | null;
  announcement_date: string | null;
  closing_date: string | null;
  sector_tags_json: string | null;
  stage_tags_json: string | null;
  geography: string | null;
  use_of_proceeds: string | null;
  source_url: string | null;
  source_type: string | null;
  source_published_at: string | null;
  sources_json: string | null;
  confidence: number;
  status: string;
}

interface SourceContribution {
  url: string;
  source_type: DealSourceType;
  published_at?: string | null;
  amount_usd?: number | null;
  announcement_date?: string | null;
  round_name?: string | null;
}

async function findCompanyByNormalizedName(env: Env, normalized: string): Promise<string | null> {
  if (!normalized) return null;
  const r = await env.DB.prepare(
    `SELECT entity_id FROM facts
      WHERE predicate = 'company.name_normalized' AND value_text = ? AND is_current = 1
      LIMIT 1`,
  ).bind(normalized).first<{ entity_id: string }>();
  return r?.entity_id ?? null;
}

async function resolveCompany(
  env: Env, c: DealCandidate, source: string,
): Promise<string | null> {
  const normalized = normalizeCompanyName(c.company_name_raw);
  if (!normalized) return null;
  const existing = await findCompanyByNormalizedName(env, normalized);
  if (existing) return existing;
  // Also try website domain match when available
  if (c.company_website) {
    try {
      const u = new URL(c.company_website);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      const r = await env.DB.prepare(
        `SELECT id FROM u_entities WHERE kind='org' AND status='active' AND primary_domain = ? LIMIT 1`,
      ).bind(host).first<{ id: string }>();
      if (r?.id) return r.id;
    } catch { /* ignore */ }
  }
  // Mint via canonical createEntity. Setting primary_url triggers
  // WF_PROFILE_FILLER auto-dispatch (orgs with website + no facts) —
  // exactly the spec's "enqueue enrichment for new companies" path.
  const row = await createEntity(env, {
    kind: "org",
    display_name: c.company_name_raw.slice(0, 200),
    primary_url: c.company_website ?? null,
    primary_domain: c.company_website ? safeHost(c.company_website) : null,
    suppressAutoProfileFill: !c.company_website,
  });
  await addRole(env, row.id, "company", { is_primary: true, source, confidence: 0.6 });
  const factCtx = {
    entity_id: row.id, source_kind: "scrape" as const, source,
    evidence_url: c.source_url, confidence: 0.6,
  };
  await insertFact(env, { ...factCtx, predicate: "company.name_normalized", value_text: normalized });
  if (c.company_website) {
    await insertFact(env, { ...factCtx, predicate: "website", value_text: c.company_website });
  }
  return row.id;
}

function safeHost(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

/** Pick canonical value: prefer higher-authority source. Ties: keep
 *  existing (stable re-ingest). Null incoming never overwrites a real
 *  existing value. */
function pickByAuthority<T>(
  existing: T | null | undefined, existingType: DealSourceType | null,
  incoming: T | null | undefined, incomingType: DealSourceType,
): T | null {
  if (incoming == null) return (existing ?? null) as T | null;
  if (existing == null) return incoming as T;
  if (existingType && isHigherAuthority(existingType, incomingType)) return existing as T;
  if (existingType && !isHigherAuthority(incomingType, existingType)) return existing as T;
  return incoming as T;
}

function parseSources(json: string | null): SourceContribution[] {
  if (!json) return [];
  try { return JSON.parse(json) as SourceContribution[]; } catch { return []; }
}

/**
 * Persist one DealCandidate. Idempotent on dedupe_key; second call with
 * same key + same source_url is a no-op (returns existing row). Same
 * key + different source URL escalates status (provisional →
 * corroborated). Same key + different source URL with conflicting hard
 * fields → disputed.
 */
export async function persistDeal(
  env: Env, c: DealCandidate, source: string,
): Promise<DealPersistResult> {
  if (c.confidence < MIN_PERSIST_CONFIDENCE) {
    return { deal_id: null, status: "provisional", was_new: false, skipped: true, reason: "low_confidence", dedupe_key: null };
  }
  if (!c.company_name_raw || c.company_name_raw.trim().length < 2) {
    return { deal_id: null, status: "provisional", was_new: false, skipped: true, reason: "no_company_name", dedupe_key: null };
  }
  const dedupe_key = await dealDedupeKey({
    company_name_raw: c.company_name_raw,
    event_type: c.event_type,
    round_name: c.round_name,
    announcement_date: c.announcement_date,
    closing_date: c.closing_date,
  });
  if (!dedupe_key) {
    // Spec: "dedupe_key must use deterministic source-supplied dates only"
    return { deal_id: null, status: "provisional", was_new: false, skipped: true, reason: "no_dedupe_key", dedupe_key: null };
  }

  const SELECT_COLS = `id, event_type, company_entity_id, company_name_raw, round_name,
            amount_usd, amount_raw, valuation_usd, valuation_type,
            announcement_date, closing_date, sector_tags_json, stage_tags_json,
            geography, use_of_proceeds, source_url, source_type, source_published_at,
            sources_json, confidence, status`;

  let existing = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM deal_events WHERE dedupe_key = ?`,
  ).bind(dedupe_key).first<ExistingDealRow>();

  // ---- Round-flexible secondary lookup -------------------------------
  // SEC Form D / 8-K synthesis emits round_name=null because the filing
  // doesn't disclose it; press wires usually have "Series X". Those must
  // still corroborate into one row. So if the primary key missed, look
  // for any existing row in the same (company, event_type, month) where
  // either side's round_name is null OR they match — that row is the
  // canonical target. We update its dedupe_key only if the incoming
  // candidate's round is more specific (the existing row had null), so
  // re-ingest of the same SEC filing keeps hitting the same row.
  if (!existing) {
    const norm = normalizeCompanyName(c.company_name_raw);
    const bucket = (c.announcement_date ?? c.closing_date ?? "").slice(0, 7);
    if (norm && bucket) {
      const incomingRound = c.round_name ?? null;
      const flex = await env.DB.prepare(
        `SELECT ${SELECT_COLS} FROM deal_events
          WHERE company_name_normalized = ? AND event_type = ?
            AND substr(COALESCE(announcement_date, closing_date), 1, 7) = ?
            AND (round_name IS NULL OR ? IS NULL OR lower(round_name) = lower(?))
          ORDER BY (round_name IS NOT NULL) DESC, created_at ASC
          LIMIT 1`,
      ).bind(norm, c.event_type, bucket, incomingRound, incomingRound).first<ExistingDealRow>();
      if (flex) {
        existing = flex;
        // If the existing row has no round_name and we now know one, upgrade
        // its dedupe_key to the new, more specific key. Wrapped in try/catch
        // because a concurrent insert on the same new key could race the
        // UNIQUE constraint — in that case the existing row stays as-is
        // and corroboration still completes via the update path below.
        if (!flex.round_name && incomingRound) {
          try {
            await env.DB.prepare(
              `UPDATE deal_events SET round_name = ?, dedupe_key = ? WHERE id = ? AND dedupe_key = ?`,
            ).bind(incomingRound, dedupe_key, flex.id, dedupe_key /* not the old; placeholder */).run();
            // Actual upgrade — bind old key separately to avoid no-op
            await env.DB.prepare(
              `UPDATE deal_events SET round_name = COALESCE(round_name, ?), dedupe_key = ?
                WHERE id = ?`,
            ).bind(incomingRound, dedupe_key, flex.id).run();
          } catch { /* unique conflict on dedupe_key — keep existing */ }
        }
      }
    }
  }

  const company_entity_id = await resolveCompany(env, c, source);

  const incomingContribution: SourceContribution = {
    url: c.source_url, source_type: c.source_type,
    published_at: c.source_published_at ?? null,
    amount_usd: c.amount_usd ?? null,
    announcement_date: c.announcement_date ?? null,
    round_name: c.round_name ?? null,
  };

  if (!existing) {
    const id = crypto.randomUUID();
    const sources_json = JSON.stringify([incomingContribution]);
    await env.DB.prepare(
      `INSERT INTO deal_events (
         id, event_type, company_entity_id, company_name_raw, company_name_normalized,
         round_name, amount_usd, amount_raw, valuation_usd, valuation_type,
         announcement_date, closing_date, sector_tags_json, stage_tags_json,
         geography, use_of_proceeds, source_url, source_type, source_published_at,
         sources_json, confidence, dedupe_key, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisional',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(
      id, c.event_type, company_entity_id, c.company_name_raw,
      normalizeCompanyName(c.company_name_raw),
      c.round_name ?? null, c.amount_usd ?? null, c.amount_raw ?? null,
      c.valuation_usd ?? null, c.valuation_type ?? null,
      c.announcement_date ?? null, c.closing_date ?? null,
      c.sector_tags ? JSON.stringify(c.sector_tags) : null,
      c.stage_tags ? JSON.stringify(c.stage_tags) : null,
      c.geography ?? null, c.use_of_proceeds ?? null,
      c.source_url, c.source_type, c.source_published_at ?? null,
      sources_json, c.confidence, dedupe_key,
    ).run();
    await writeDerivedFacts(env, id, company_entity_id, c, source);
    await upsertParticipants(env, id, c, source);
    // Task #9: replay the new deal as a primary_round valuation_mark
    // when a valuation is present. Idempotent (dedupe_key UNIQUE).
    if (c.event_type === "funding_round" && c.valuation_usd != null) {
      try {
        const { landMarkFromDealEvent } = await import("../valuation/markDrivers.js");
        await landMarkFromDealEvent(env, id);
      } catch (e) {
        console.warn("valuation mark replay failed", id, (e as Error).message);
      }
    }
    return { deal_id: id, status: "provisional", was_new: true, skipped: false, dedupe_key };
  }

  // ---- corroboration / dispute path ----
  const priorSources = parseSources(existing.sources_json);
  const sameUrlAlready = priorSources.some((s) => s.url === c.source_url);
  if (sameUrlAlready) {
    // Re-ingest of the exact same source URL — refresh participants
    // (may have been re-resolved) but don't churn the row.
    await upsertParticipants(env, existing.id, c, source);
    return {
      deal_id: existing.id,
      status: existing.status as "provisional" | "corroborated" | "disputed",
      was_new: false, skipped: false, reason: "same_source_replay", dedupe_key,
    };
  }
  const allSources = [...priorSources, incomingContribution];
  const distinctTypes = new Set(allSources.map((s) => s.source_type));
  const existingType = (existing.source_type ?? null) as DealSourceType | null;
  const conflict = hasHardConflict(
    { amount_usd: existing.amount_usd, announcement_date: existing.announcement_date },
    { amount_usd: c.amount_usd ?? null, announcement_date: c.announcement_date ?? null },
  );
  const incomingIsHigher = existingType ? isHigherAuthority(c.source_type, existingType) : true;
  const nextStatus: "provisional" | "corroborated" | "disputed" =
    conflict ? "disputed" :
    allSources.length >= 2 || distinctTypes.size >= 2 ? "corroborated" :
    (existing.status as "provisional" | "corroborated" | "disputed");

  // Per-field canonical pick by authority. Higher-authority incoming
  // overwrites; lower-authority incoming only fills nulls.
  const nextCompanyId = company_entity_id ?? existing.company_entity_id;
  const nextRound       = pickByAuthority(existing.round_name, existingType, c.round_name ?? null, c.source_type);
  const nextAmount      = pickByAuthority(existing.amount_usd, existingType, c.amount_usd ?? null, c.source_type);
  const nextAmountRaw   = pickByAuthority(existing.amount_raw, existingType, c.amount_raw ?? null, c.source_type);
  const nextValuation   = pickByAuthority(existing.valuation_usd, existingType, c.valuation_usd ?? null, c.source_type);
  const nextValType     = pickByAuthority(existing.valuation_type, existingType, c.valuation_type ?? null, c.source_type);
  const nextAnnounce    = pickByAuthority(existing.announcement_date, existingType, c.announcement_date ?? null, c.source_type);
  const nextClosing     = pickByAuthority(existing.closing_date, existingType, c.closing_date ?? null, c.source_type);
  const nextGeo         = pickByAuthority(existing.geography, existingType, c.geography ?? null, c.source_type);
  const nextUse         = pickByAuthority(existing.use_of_proceeds, existingType, c.use_of_proceeds ?? null, c.source_type);
  const nextSourceUrl   = incomingIsHigher ? c.source_url : existing.source_url;
  const nextSourceType  = incomingIsHigher ? c.source_type : (existing.source_type ?? c.source_type);
  const nextSourcePub   = incomingIsHigher ? (c.source_published_at ?? null) : (existing.source_published_at ?? c.source_published_at ?? null);
  const nextConfidence  = Math.min(0.99, Math.max(existing.confidence, c.confidence) + (nextStatus === "corroborated" ? 0.1 : 0));

  await env.DB.prepare(
    `UPDATE deal_events SET
       event_type = ?, company_entity_id = ?, round_name = ?, amount_usd = ?, amount_raw = ?,
       valuation_usd = ?, valuation_type = ?, announcement_date = ?, closing_date = ?,
       geography = ?, use_of_proceeds = ?, source_url = ?, source_type = ?,
       source_published_at = ?, sources_json = ?, confidence = ?, status = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(
    existing.event_type, nextCompanyId, nextRound, nextAmount, nextAmountRaw,
    nextValuation, nextValType, nextAnnounce, nextClosing,
    nextGeo, nextUse, nextSourceUrl, nextSourceType,
    nextSourcePub, JSON.stringify(allSources), nextConfidence, nextStatus,
    existing.id,
  ).run();
  await writeDerivedFacts(env, existing.id, nextCompanyId, {
    ...c, amount_usd: nextAmount, round_name: (nextRound as DealCandidate["round_name"]) ?? null,
    announcement_date: nextAnnounce, valuation_usd: nextValuation,
  }, source);
  await upsertParticipants(env, existing.id, c, source);
  // Task #9: re-replay on corroboration — a higher-authority source may
  // have just supplied the valuation that was previously null. Idempotent.
  if (existing.event_type === "funding_round" && nextValuation != null) {
    try {
      const { landMarkFromDealEvent } = await import("../valuation/markDrivers.js");
      await landMarkFromDealEvent(env, existing.id);
    } catch (e) {
      console.warn("valuation mark re-replay failed", existing.id, (e as Error).message);
    }
  }
  return {
    deal_id: existing.id, status: nextStatus, was_new: false, skipped: false, dedupe_key,
  };
}

async function upsertParticipants(
  env: Env, deal_id: string, c: DealCandidate, source: string,
): Promise<void> {
  const all: Array<{ name: string; role: "lead" | "participating" }> = [];
  for (const n of c.lead_investors) all.push({ name: n, role: "lead" });
  for (const n of c.participating_investors) all.push({ name: n, role: "participating" });
  for (const p of all) {
    if (!p.name || p.name.trim().length < 2) continue;
    const resolved = await resolveInvestor(env, p.name, {
      source, evidence_url: c.source_url,
    });
    try {
      await env.DB.prepare(
        `INSERT INTO deal_participants (
           id, deal_id, investor_entity_id, investor_name_raw, role,
           source_url, source_type, confidence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deal_id, investor_name_raw, role) DO UPDATE SET
           investor_entity_id = COALESCE(excluded.investor_entity_id, deal_participants.investor_entity_id),
           confidence = MAX(excluded.confidence, deal_participants.confidence),
           source_url = COALESCE(deal_participants.source_url, excluded.source_url),
           source_type = COALESCE(deal_participants.source_type, excluded.source_type)`,
      ).bind(
        crypto.randomUUID(), deal_id, resolved.investor_entity_id, p.name.trim(), p.role,
        c.source_url, c.source_type, resolved.confidence,
      ).run();
    } catch (e) {
      console.warn("deal_participants upsert failed", (e as Error).message);
    }
    // Mirror a participation fact on the investor entity so investor-
    // history queries can also pivot via facts.
    if (resolved.investor_entity_id) {
      await insertFact(env, {
        entity_id: resolved.investor_entity_id,
        predicate: "investor.deal_participation",
        value_text: c.company_name_raw,
        value_entity_id: deal_id,
        value_json: {
          deal_id, role: p.role, round_name: c.round_name ?? null,
          amount_usd: c.amount_usd ?? null, announcement_date: c.announcement_date ?? null,
          company_name: c.company_name_raw,
        },
        source_kind: "scrape", source, evidence_url: c.source_url,
        confidence: resolved.confidence,
      });
    }
  }
}

async function writeDerivedFacts(
  env: Env, deal_id: string, company_entity_id: string | null,
  c: DealCandidate, source: string,
): Promise<void> {
  if (!company_entity_id) return;
  const factCtx = {
    entity_id: company_entity_id, source_kind: "scrape" as const, source,
    evidence_url: c.source_url, confidence: c.confidence,
  };
  if (c.amount_usd != null) {
    await insertFact(env, { ...factCtx, predicate: "last_round_usd", value_number: c.amount_usd });
  }
  if (c.round_name) {
    await insertFact(env, { ...factCtx, predicate: "last_round_name", value_text: c.round_name });
  }
  if (c.announcement_date) {
    await insertFact(env, { ...factCtx, predicate: "last_round_date", value_text: c.announcement_date });
  }
  if (c.valuation_usd != null) {
    await insertFact(env, { ...factCtx, predicate: "last_round_valuation_usd", value_number: c.valuation_usd });
  }
  // Tag the company fact with the deal id so /api/companies/:id/deal-history
  // has a fact-only fallback when the deal_events index is being rebuilt.
  await insertFact(env, {
    ...factCtx, predicate: "company.deal_event",
    value_text: c.company_name_raw, value_entity_id: deal_id,
    value_json: {
      deal_id, event_type: c.event_type, round_name: c.round_name ?? null,
      amount_usd: c.amount_usd ?? null, announcement_date: c.announcement_date ?? null,
    },
  });
}

// ---- SEC EDGAR synthesis ------------------------------------------------
// Called from services/secEdgar/persist.ts after persistFormD / persist8K
// has already written the structured sec_* row. We never refetch; we
// only project an already-parsed payload into a DealCandidate and run
// it through the same persist + dedupe path as the press-wire adapters.

export async function synthesizeDealFromFormD(
  env: Env, h: FilingHeader, d: FormDPayload,
): Promise<DealPersistResult | null> {
  if (!d.issuer_name) return null;
  const announcement = d.date_of_first_sale ?? h.filed_at ?? h.period_of_report ?? null;
  if (!announcement) return null;
  const amount = d.total_offering_amount ?? d.total_amount_sold ?? null;
  // SEC Form D doesn't disclose round_name — we leave it null and let the
  // month-bucket dedupe collapse it with a press-release corroboration.
  const candidate: DealCandidate = {
    event_type: "funding_round",
    company_name_raw: d.issuer_name,
    company_website: null,
    round_name: null,
    amount_usd: amount,
    amount_raw: amount != null ? `$${amount}` : null,
    valuation_usd: null,
    valuation_type: "unknown",
    lead_investors: [],
    participating_investors: [],
    announcement_date: announcement,
    closing_date: null,
    sector_tags: d.industry_group ? [d.industry_group] : [],
    stage_tags: [],
    geography: d.issuer_jurisdiction ?? null,
    use_of_proceeds: null,
    source_url: h.filing_url,
    source_type: "sec_filing",
    source_published_at: h.filed_at ?? null,
    confidence: 0.95,
  };
  try {
    return await persistDeal(env, candidate, "sec_form_d:deal_synth");
  } catch (e) {
    console.warn("synthesizeDealFromFormD failed", (e as Error).message);
    return null;
  }
}

const FORM8K_DEAL_ITEMS: Record<string, DealEventType> = {
  "1.01": "funding_round",      // Entry into a Material Definitive Agreement (often M&A or financing)
  "2.01": "acquisition",        // Completion of Acquisition or Disposition of Assets
  "3.02": "funding_round",      // Unregistered Sales of Equity Securities
  "8.01": "funding_round",      // Other Events (used for round announcements)
};

export async function synthesizeDealFromForm8K(
  env: Env, h: FilingHeader, d: Form8KPayload,
): Promise<DealPersistResult[]> {
  if (!d.issuer_name || !d.items.length) return [];
  const out: DealPersistResult[] = [];
  const seenTypes = new Set<DealEventType>();
  for (const item of d.items) {
    const eventType = FORM8K_DEAL_ITEMS[item.item_number];
    if (!eventType) continue;
    if (seenTypes.has(eventType)) continue; // one row per event_type per filing
    seenTypes.add(eventType);
    const announcement = d.event_date ?? h.filed_at ?? null;
    if (!announcement) continue;
    const candidate: DealCandidate = {
      event_type: eventType,
      company_name_raw: d.issuer_name,
      company_website: null,
      round_name: null,
      amount_usd: null, amount_raw: null,
      valuation_usd: null, valuation_type: "unknown",
      lead_investors: [], participating_investors: [],
      announcement_date: announcement,
      closing_date: null,
      sector_tags: [], stage_tags: [],
      geography: null,
      use_of_proceeds: item.summary ?? item.item_title ?? null,
      source_url: h.filing_url,
      source_type: "sec_filing",
      source_published_at: h.filed_at ?? null,
      confidence: 0.85,
    };
    try {
      const r = await persistDeal(env, candidate, `sec_form_8k:item_${item.item_number}`);
      if (r) out.push(r);
    } catch (e) {
      console.warn("synthesizeDealFromForm8K failed", (e as Error).message);
    }
  }
  return out;
}
