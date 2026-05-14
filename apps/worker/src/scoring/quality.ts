import {
  QUALITY_WEIGHTS,
  COMPLETENESS_FIELDS,
  TRACK_RECORD_FIELDS,
  FRESHNESS_HALFLIFE_DAYS,
} from "./config";

export interface QualityBreakdown {
  score: number;
  completeness: number;
  verification: number;
  corroboration: number;
  freshness: number;
  persona_match: number;
  track_record: number;
  details: {
    filled_fields: string[];
    missing_fields: string[];
    providers: string[];
    days_since_enriched: number | null;
  };
}

interface LeadLike {
  [k: string]: unknown;
  verified?: number | boolean | null;
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  persona_role?: string | null;
  seniority?: string | null;
  last_enriched_at?: string | null;
  enrichment_log_json?: string | null;
}

function jsonArrayLen(raw: unknown): number {
  if (!raw || typeof raw !== "string") return 0;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.length : 0;
  } catch { return 0; }
}

function nonEmpty(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return true;
  return false;
}

export function computeQuality(lead: LeadLike): QualityBreakdown {
  // 1. Completeness — fraction of important fields filled.
  const filled: string[] = [];
  const missing: string[] = [];
  for (const f of COMPLETENESS_FIELDS) {
    if (nonEmpty(lead[f])) filled.push(f); else missing.push(f);
  }
  const completeness = filled.length / COMPLETENESS_FIELDS.length;

  // 2. Verification — verified flag (50%), email (25%), phone or linkedin (25%).
  let verification = 0;
  if (lead.verified === 1 || lead.verified === true) verification += 0.5;
  if (nonEmpty(lead.email)) verification += 0.25;
  if (nonEmpty(lead.phone) || nonEmpty(lead.linkedin_url)) verification += 0.25;
  if (verification > 1) verification = 1;

  // 3. Corroboration — distinct providers attesting at least one field.
  // 1 provider → 0.34, 2 → 0.67, 3+ → 1.0.
  const providers: string[] = [];
  if (lead.enrichment_log_json && typeof lead.enrichment_log_json === "string") {
    try {
      const log = JSON.parse(lead.enrichment_log_json);
      if (Array.isArray(log?.providers)) {
        for (const p of log.providers) if (typeof p === "string") providers.push(p);
      } else if (Array.isArray(log)) {
        for (const e of log) if (typeof e?.provider === "string") providers.push(e.provider);
      }
    } catch { /* malformed log is treated as zero corroboration */ }
  }
  const distinct = Array.from(new Set(providers));
  const corroboration = Math.min(1, distinct.length / 3);

  // 4. Freshness — exponential decay; full credit if enriched <halflife days ago.
  let freshness = 0;
  let daysSince: number | null = null;
  if (lead.last_enriched_at) {
    const ms = Date.now() - new Date(lead.last_enriched_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) {
      daysSince = ms / 86400_000;
      freshness = Math.pow(0.5, daysSince / FRESHNESS_HALFLIFE_DAYS);
    }
  }

  // 5. Persona match — both persona_role and seniority set ⇒ 1, only role ⇒ 0.5.
  let persona_match = 0;
  if (nonEmpty(lead.persona_role) && nonEmpty(lead.seniority)) persona_match = 1;
  else if (nonEmpty(lead.persona_role)) persona_match = 0.5;

  // 6. Track record — non-empty JSON arrays in TRACK_RECORD_FIELDS, normalized.
  let trCount = 0;
  for (const f of TRACK_RECORD_FIELDS) if (jsonArrayLen(lead[f]) > 0) trCount += 1;
  const track_record = trCount / TRACK_RECORD_FIELDS.length;

  const score =
    QUALITY_WEIGHTS.completeness * completeness +
    QUALITY_WEIGHTS.verification * verification +
    QUALITY_WEIGHTS.corroboration * corroboration +
    QUALITY_WEIGHTS.freshness * freshness +
    QUALITY_WEIGHTS.persona_match * persona_match +
    QUALITY_WEIGHTS.track_record * track_record;

  return {
    score: Math.round(score * 1000) / 1000,
    completeness: Math.round(completeness * 1000) / 1000,
    verification: Math.round(verification * 1000) / 1000,
    corroboration: Math.round(corroboration * 1000) / 1000,
    freshness: Math.round(freshness * 1000) / 1000,
    persona_match: Math.round(persona_match * 1000) / 1000,
    track_record: Math.round(track_record * 1000) / 1000,
    details: {
      filled_fields: filled,
      missing_fields: missing,
      providers: distinct,
      days_since_enriched: daysSince == null ? null : Math.round(daysSince * 10) / 10,
    },
  };
}
