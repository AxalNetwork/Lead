// Task #2: SiteAdapter contract.
//
// Adapters are PURE EXTRACTORS. They take (html, url, ctx) and return a
// structured `AdapterResult`. They must NEVER write to the database and
// must NEVER make additional network calls — the engine has already
// fetched the page (and stored a copy in R2 for replay).
//
// Selection is registry-driven: an adapter declares which hosts and url
// patterns it claims, and the highest-priority match wins. If the
// extract() throws or returns confidence < 0.2, the engine falls back
// to the generic extractor — a broken adapter must never block
// ingestion.

export interface AdapterCandidate {
  /** Profile-types registry id (e.g. "gp_partner", "investor_vc"). */
  profile_type: string | null;
  /** 0..1 score for downstream merge. */
  confidence: number;
  name?: string | null;
  url?: string | null;
  /** Free-form structured data — keys should match the profile-type's
   *  `enrichment_predicates` where possible so the persister can merge
   *  without a per-adapter mapper. */
  data: Record<string, unknown>;
}

export interface AdapterResult {
  /** Identifier of the adapter that produced this result. */
  adapter_id: string;
  /** Aggregate confidence — typically max(candidate.confidence). */
  confidence: number;
  /** One row per detected entity / candidate. */
  candidates: AdapterCandidate[];
  /** Outbound URLs the engine should consider for the frontier. Used by
   *  directory pages (e.g. /team) that produce many child profile URLs. */
  child_urls: string[];
  /** Free-form notes for debugging. Never persisted. */
  notes?: Record<string, unknown>;
}

export interface AdapterContext {
  /** ISO timestamp the host page was fetched. */
  fetched_at?: string;
  /** Final URL after any redirects. */
  final_url?: string;
}

export interface SiteAdapter {
  /** Stable identifier used in logs and tests. */
  id: string;
  /** Higher wins on conflict (range: 0..100). */
  priority: number;
  /** Hostnames the adapter claims, e.g. ["linkedin.com","www.linkedin.com"]. */
  hosts: string[];
  /** Path regexes the URL must match (any-of). */
  url_patterns: RegExp[];
  /** Profile-types registry ids this adapter ever emits. */
  profile_types_emitted: string[];
  extract(html: string, url: string, ctx?: AdapterContext): AdapterResult;
}
