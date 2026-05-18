// Task #3: Deal dedupe + source-authority helpers.
//
// One place computes the dedupe_key so every adapter, every source
// (SEC, press wire, tech press), and every backfill collapses into the
// same `deal_events` row. The formula is intentionally coarse:
//
//   dedupe_key = sha256(normalized_company + "|" + round_name + "|" + month_bucket)
//
// where month_bucket is YYYY-MM of the announcement_date (or closing_date
// when announcement is missing). The month bucket absorbs the typical
// 0–4 week press-cycle spread between SEC filing date, company blog
// post, and tech-press write-up of the same round, while staying tight
// enough that a true follow-on a quarter later doesn't fold in.
//
// Source authority (highest first):
//   sec_filing > company_blog > press_release > tech_press
// Per-field canonical values are picked by highest authority; on hard-
// field disagreement (amount, announcement_date) within the same key,
// status flips to `disputed` and BOTH source URLs are retained on the
// row's `sources_json`.

import type { DealSourceType } from "./types";

const SOURCE_AUTHORITY_RANK: Record<DealSourceType, number> = {
  sec_filing:    100,
  company_blog:   75,
  press_release:  50,
  tech_press:     25,
};

export function sourceAuthorityRank(t: DealSourceType): number {
  return SOURCE_AUTHORITY_RANK[t] ?? 0;
}

/** Higher-authority source wins. Ties prefer `a` (the existing
 *  canonical pick) so re-ingesting the same row is stable. */
export function isHigherAuthority(a: DealSourceType, b: DealSourceType): boolean {
  return sourceAuthorityRank(a) > sourceAuthorityRank(b);
}

/**
 * Normalize a company name for dedupe. Same shape as fundResolver's
 * normalizer (lower-case, strip legal suffixes, collapse punctuation)
 * but tuned for company names rather than fund names:
 *   - keeps numeric tokens (e.g. "23andMe", "Acme 4")
 *   - strips "the " prefix
 *   - strips parenthetical disambiguators ("Acme (Delaware)" → "acme")
 *
 * Exported for the dedupe test + ad-hoc lookups.
 */
export function normalizeCompanyName(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase().trim();
  s = s.replace(/^the\s+/, "");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(
    /\b(l\.?p\.?|llc|l\.?l\.?c\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|gmbh|ag|s\.?a\.?|n\.?v\.?|plc|bv|sas|sarl|co\.?|company)\b/g,
    " ",
  );
  s = s.replace(/[.,;:'"!?/\\&_+\-]+/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Canonicalize round_name for dedupe so "series a", "Series A", "A round"
 * all collapse. Returns "" when round_name is missing — dedupe_key still
 * works (it just relies on company + month bucket).
 */
export function normalizeRoundName(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim().toLowerCase()
    .replace(/^series\s+/i, "series ")
    .replace(/\s+round$/i, "")
    .replace(/[.,;:'"!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/** YYYY-MM bucket of the canonical event date. Returns "" when both
 *  dates are missing (the caller should refuse to persist in that case
 *  — a dedupe_key without a time bucket would over-collapse). */
export function monthBucket(announcement: string | null | undefined,
                            closing: string | null | undefined): string {
  const d = (announcement ?? closing ?? "").trim();
  if (!/^\d{4}-\d{2}/.test(d)) return "";
  return d.slice(0, 7);
}

/** Returns null on bad input (caller refuses to persist).
 *
 * Includes `event_type` in the key so that distinct events for the
 * same company in the same month (e.g. a Series B funding_round and
 * an unrelated 8-K acquisition synthesized in the same period) do NOT
 * collide. Note that SEC Form D synthesis emits round_name=null while
 * press wires usually emit a `Series X` — those still need to corroborate
 * into one row; that's handled by the persist layer's secondary
 * "round-flexible" lookup, not by the dedupe key itself.
 */
export async function dealDedupeKey(args: {
  company_name_raw: string;
  event_type: string;
  round_name: string | null | undefined;
  announcement_date: string | null | undefined;
  closing_date: string | null | undefined;
}): Promise<string | null> {
  const norm = normalizeCompanyName(args.company_name_raw);
  const bucket = monthBucket(args.announcement_date, args.closing_date);
  if (!norm || !bucket || !args.event_type) return null;
  const round = normalizeRoundName(args.round_name);
  const material = `${norm}|${args.event_type}|${round}|${bucket}`;
  const buf = new TextEncoder().encode(material);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * Hard-field conflict detector. Two sources disagree if either:
 *   - amount_usd differs by more than 5% AND both are present
 *   - announcement_date differs by more than 14 days AND both are present
 *
 * Soft fields (sector tags, use_of_proceeds, geography, valuation_type)
 * never trigger disputed status — they merge through normal authority
 * picking.
 */
export function hasHardConflict(
  a: { amount_usd?: number | null; announcement_date?: string | null },
  b: { amount_usd?: number | null; announcement_date?: string | null },
): boolean {
  if (a.amount_usd != null && b.amount_usd != null) {
    const max = Math.max(a.amount_usd, b.amount_usd);
    const min = Math.min(a.amount_usd, b.amount_usd);
    if (max > 0 && (max - min) / max > 0.05) return true;
  }
  if (a.announcement_date && b.announcement_date) {
    const da = Date.parse(a.announcement_date);
    const db = Date.parse(b.announcement_date);
    if (Number.isFinite(da) && Number.isFinite(db)) {
      if (Math.abs(da - db) > 14 * 24 * 60 * 60 * 1000) return true;
    }
  }
  return false;
}
