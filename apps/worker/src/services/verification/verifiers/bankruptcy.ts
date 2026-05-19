// Bankruptcy verifier.
//
// Two paths, picked in order:
//   1. PACER PCL (paid) when PACER_USER+PACER_PASS are set — the
//      authoritative federal-bankruptcy lookup. Real PCL flow is a
//      follow-up (taskRef #20); we stub it as `unverifiable` with a
//      machine-readable reason so the contract is honest.
//   2. CourtListener `court_type=B` (bankruptcy-court ingested RECAP
//      collection) when COURTLISTENER_TOKEN is set — partial federal
//      coverage but real, in-house-fetched signal.

import { fetchPage } from "../../../scraper/fetcher";
import type { Verifier, VerifierResult } from "../types";

interface ClRes { results: Array<{ caseName?: string; absolute_url?: string; dateFiled?: string }>; count?: number }

export const bankruptcyVerifier: Verifier = {
  name: "bankruptcy",
  version: "0.2.0",
  supports(c) { return c.predicate === "person.bankruptcy_check"; },
  async verify(env, _personId, claim): Promise<VerifierResult> {
    const p = claim.payload as { person_name?: string };
    const name = (p.person_name ?? "").trim();
    if (!name) return { status: "skipped", confidence: 0, reason: "missing_name" };

    // Authoritative federal-bankruptcy lookup is PACER PCL — tracked
    // separately as taskRef #20. Until that client lands we always
    // run the CourtListener bankruptcy-court (RECAP `court_type=B`)
    // check, which has real (partial) federal coverage, rather than
    // short-circuiting on PACER cred presence.
    const pacerUser = (env as unknown as { PACER_USER?: string }).PACER_USER;
    const pacerPass = (env as unknown as { PACER_PASS?: string }).PACER_PASS;
    const pacerNote = pacerUser && pacerPass ? "pacer_pcl_pending_taskRef_20" : "pacer_unconfigured";

    const token = (env as unknown as { COURTLISTENER_TOKEN?: string }).COURTLISTENER_TOKEN;
    if (!token) {
      return { status: "unverifiable", confidence: 0.2, reason: `no_bankruptcy_source_configured (${pacerNote}, courtlistener_unconfigured)` };
    }
    const url = `https://www.courtlistener.com/api/rest/v3/search/?type=r&court_type=B&q=${encodeURIComponent(`"${name}"`)}`;
    try {
      const res = await fetchPage(env, url, {
        liveOnly: true,
        timeoutMs: 15_000,
        headers: { Authorization: `Token ${token}`, Accept: "application/json" },
      });
      if (!res.ok || !res.html) {
        return { status: "unverifiable", confidence: 0.2, reason: `cl_fetch_${res.blockReason ?? "failed"}`, evidence_url: url };
      }
      let body: ClRes;
      try { body = JSON.parse(res.html) as ClRes; } catch { return { status: "unverifiable", confidence: 0.2, reason: "cl_parse_failed", evidence_url: url }; }
      const count = body.count ?? body.results?.length ?? 0;
      if (count === 0) {
        return {
          status: "confirmed",
          confidence: 0.6,
          evidence_url: url,
          sources: [url],
          evidence_snippet: `CourtListener bankruptcy-court search: 0 hits for "${name}". Coverage is partial (not all districts ingested; PACER PCL is the authoritative source — taskRef #20).`,
          derived_predicate: "person.bankruptcy.hits",
          derived_value_text: "0",
          reason: `courtlistener_b_only (${pacerNote})`,
        };
      }
      const first = body.results?.[0];
      const evidenceUrl = first?.absolute_url ? `https://www.courtlistener.com${first.absolute_url}` : url;
      return {
        status: "contradicted",
        confidence: 0.75,
        evidence_url: evidenceUrl,
        sources: [url],
        evidence_snippet: `CourtListener bankruptcy-court search: ${count} hit(s); first: ${first?.caseName ?? "case"} (${first?.dateFiled ?? "unknown date"}).`,
        derived_predicate: "person.bankruptcy.hits",
        derived_value_text: String(count),
        reason: "bankruptcy_match",
      };
    } catch (e) {
      return { status: "unverifiable", confidence: 0.2, reason: `cl_error:${(e as Error).message}` };
    }
  },
};
