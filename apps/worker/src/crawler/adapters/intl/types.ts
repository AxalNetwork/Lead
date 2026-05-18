// Task #3: IntlAdapter contract.
//
// One contract for every jurisdictional adapter. The four methods are
// ORCHESTRATORS: they take the canonical input (`name` / `source_id`
// / `since`), build the per-source URL, fetch via the crawler engine,
// and return a typed result. Pure parsers live alongside as `parsePage`
// so the extractor can route an already-fetched page through the same
// adapter without re-fetching.
//
// The engine routes by either an explicit `jurisdiction` hint on the
// seed row (preferred) or a host / TLD fallback (intl/registry).

import type { Env } from "../../../types";

/** ISO-3166 alpha-2 country code or 'EU' for pan-European registries. */
export type JurisdictionCode =
  | "UK" | "EU" | "DE" | "FR" | "NL" | "SE" | "ES" | "IT" | "IE"
  | "SG" | "IL" | "IN" | "CN" | "HK" | "CA" | "AU" | "BR";

/** Canonical entity row. Stable per-source identifier so re-hits dedupe. */
export interface IntlEntityHit {
  jurisdiction: JurisdictionCode;
  source_id: string;
  display_name: string;
  kind: "company" | "fund" | "adviser" | "manager" | "person";
  url: string;
  confidence: number;
  display_name_original?: string | null;
  /** ISO-639-1 of the original-language name. */
  original_lang?: string | null;
}

/** A jurisdiction-typed filing observation. `amount_usd` is the
 *  USD-normalized number; the raw {amount, currency, fx_as_of} MUST be
 *  retained in `source_evidence_json` so the conversion can be replayed. */
export interface IntlFiling {
  jurisdiction: JurisdictionCode;
  source_id: string;
  filer_name: string;
  filer_source_id?: string | null;
  filing_type: string;
  filed_at: string;           // ISO date
  url: string;
  amount_usd?: number | null;
  /** Raw {amount, currency} when the adapter knows them — used by the
   *  persist layer to call toUsd and stamp `amount_usd`. */
  raw_amount?: number | null;
  raw_currency?: string | null;
  data: Record<string, unknown>;
  original_lang?: string | null;
  original_text?: string | null;
  english_text?: string | null;
  source_evidence_json: Record<string, unknown>;
}

export interface IntlAdapter {
  jurisdiction: JurisdictionCode;
  id: string;
  hosts: string[];
  throttle: { rps: number; burst: number };
  needs_translation: boolean;

  /** Resolve a free-text name to one or more entity hits in this
   *  jurisdiction. Internally builds the source URL, fetches via the
   *  crawler engine, and parses. */
  searchEntity(env: Env, name: string): Promise<IntlEntityHit[]>;
  /** Fetch + parse a company profile for a stable source id. */
  getCompanyProfile(env: Env, source_id: string): Promise<IntlEntityHit | null>;
  /** Fetch + parse a fund profile when the source distinguishes them
   *  (SEBI AIF / AMAC fund registries / ACRA UEN of funds). Returns
   *  null when the source has no fund-vs-company distinction. */
  getFundProfile(env: Env, source_id: string): Promise<IntlEntityHit | null>;
  /** Pull filings published on or after `since`. Persist layer converts
   *  amounts and translates non-English text. */
  streamRecentFilings(env: Env, since: string): Promise<IntlFiling[]>;

  /** Extractor integration: parse an already-fetched HTML page that the
   *  registry has routed to this adapter. Pure / synchronous so the
   *  engine can call it inside the existing fetch->extract pipeline
   *  without a second fetch. Returns null when the page doesn't match
   *  a known per-source profile shape. */
  parsePage(html: string, url: string): IntlEntityHit | null;
}
