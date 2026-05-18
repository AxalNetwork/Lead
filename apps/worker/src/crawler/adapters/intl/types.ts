// Task #3: IntlAdapter contract.
//
// One contract for every jurisdictional adapter. The crawler engine
// never special-cases a jurisdiction — it routes by an explicit
// `jurisdiction` hint on the seed row (preferred) or by a TLD/host
// fallback heuristic (intl/registry.tldToJurisdiction).
//
// The four methods are NETWORK-FREE in this contract: like the
// SiteAdapter pattern, each takes already-fetched HTML/JSON and
// returns a structured payload. The engine's fetcher.ts handles
// network, robots, per-host throttle, and R2 archival. The methods
// are typed as Promise<…> because some persistence side-channels
// (fund resolver, translation) are async — the parse itself stays
// synchronous and pure.

import type { AdapterCandidate } from "../types";

/** ISO-3166 alpha-2 country code or 'EU' for pan-European registries. */
export type JurisdictionCode =
  | "UK" | "EU" | "DE" | "FR" | "NL" | "SE" | "ES" | "IT" | "IE"
  | "SG" | "IL" | "IN" | "CN" | "HK" | "CA" | "AU" | "BR";

/** Canonical entity row returned by every adapter's searchEntity. */
export interface IntlEntityHit {
  jurisdiction: JurisdictionCode;
  /** Stable per-source identifier (Companies House number, MAS UEN,
   *  AMAC manager_id, …). Adapters MUST emit something stable here so
   *  the engine can dedupe re-hits. */
  source_id: string;
  display_name: string;
  /** Free-form classification — "adviser" / "manager" / "fund" / "company". */
  kind: "company" | "fund" | "adviser" | "manager" | "person";
  url: string;
  confidence: number;
  /** Original-language display name when different from English. */
  display_name_original?: string | null;
  /** Original-language ISO-639-1 code (e.g. 'de','zh','he','fr'). */
  original_lang?: string | null;
}

/** A jurisdiction-typed filing observation. Money fields are USD-
 *  normalized (via services/intl/fx); raw currency + amount retained in
 *  source_evidence_json so downstream auditors can replay. */
export interface IntlFiling {
  jurisdiction: JurisdictionCode;
  source_id: string;          // accession / register number / publication id
  filer_name: string;
  filer_source_id?: string | null;
  filing_type: string;        // free-form per source (e.g. "AIFMD-quarterly")
  filed_at: string;           // ISO date
  url: string;
  /** USD amount when the filing has a single material amount line. */
  amount_usd?: number | null;
  /** Free-form structured payload for the per-form parsers. */
  data: Record<string, unknown>;
  /** Original-language text + translation when applicable. */
  original_lang?: string | null;
  original_text?: string | null;
  english_text?: string | null;
  /** Untransformed source evidence — must include raw currency/amount
   *  when amount_usd was synthesised. */
  source_evidence_json: Record<string, unknown>;
}

export interface IntlAdapter {
  /** ISO-3166 alpha-2 or 'EU'. */
  jurisdiction: JurisdictionCode;
  /** Stable id used in logs/registry. */
  id: string;
  /** Hosts the adapter is bound to — used by the TLD/host fallback
   *  router and the per-host throttle. */
  hosts: string[];
  /** Per-source politeness contract enforced by the engine's
   *  HostThrottle DO. */
  throttle: {
    /** Max requests-per-second to ANY host listed in `hosts`. */
    rps: number;
    /** Burst capacity (token-bucket). */
    burst: number;
  };
  /** Whether this adapter requires the translation layer (non-English
   *  registries — DE/FR/CN/IL/JP/etc). Hint only; translate.ts is the
   *  authority on language detection. */
  needs_translation: boolean;

  searchEntity(html: string, url: string, query: string): Promise<IntlEntityHit[]>;
  getCompanyProfile(html: string, url: string): Promise<IntlEntityHit | null>;
  getFundProfile(html: string, url: string): Promise<IntlEntityHit | null>;
  streamRecentFilings(html: string, url: string, since: string): Promise<IntlFiling[]>;
}

/** AdapterCandidate flavour intl adapters can hand back to the engine's
 *  existing candidate-merge path. The shared `intl/registry.toCandidate`
 *  packs an IntlEntityHit into this shape. */
export type IntlCandidate = AdapterCandidate;
