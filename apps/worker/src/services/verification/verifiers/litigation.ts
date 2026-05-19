// Litigation verifier — CourtListener federal RECAP coverage.
//
// CourtListener's /api/rest/v3/search/?type=r endpoint searches RECAP
// (federal civil dockets). State civil-docket coverage on CourtListener
// is essentially absent (CL state-court coverage is *opinions* via
// `type=o`, not civil dockets), so we DO NOT issue a state query — it
// would conflate appellate opinions with civil-litigation hits and risk
// false "contradicted" findings. State civil coverage is out of scope
// for v0.2 and tracked separately.
//
// All fetches go through the in-house tiered fetcher (fetchPage) so we
// inherit rate-limiting, retry, and proxy-tier semantics rather than
// calling fetch() directly.

import { fetchPage } from "../../../scraper/fetcher";
import type { Verifier, VerifierResult } from "../types";

interface ClRes { results: Array<{ caseName?: string; absolute_url?: string; dateFiled?: string }>; count?: number }

async function clQuery(env: import("../../../types").Env, url: string, token: string): Promise<ClRes | null> {
  try {
    const res = await fetchPage(env, url, {
      liveOnly: true,
      timeoutMs: 15_000,
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    });
    if (!res.ok || !res.html) return null;
    try { return JSON.parse(res.html) as ClRes; } catch { return null; }
  } catch { return null; }
}

export const litigationVerifier: Verifier = {
  name: "litigation",
  version: "0.2.0",
  supports(c) { return c.predicate === "person.litigation_check"; },
  async verify(env, _personId, claim): Promise<VerifierResult> {
    const p = claim.payload as { person_name?: string };
    const name = (p.person_name ?? "").trim();
    if (!name) return { status: "skipped", confidence: 0, reason: "missing_name" };
    const token = (env as unknown as { COURTLISTENER_TOKEN?: string }).COURTLISTENER_TOKEN;
    if (!token) {
      return { status: "unverifiable", confidence: 0.2, reason: "courtlistener_unconfigured" };
    }
    const q = encodeURIComponent(`"${name}"`);
    const fedUrl = `https://www.courtlistener.com/api/rest/v3/search/?type=r&q=${q}`;
    const fed = await clQuery(env, fedUrl, token);
    if (!fed) return { status: "unverifiable", confidence: 0.2, reason: "cl_fetch_failed" };
    const fedCount = fed.count ?? fed.results?.length ?? 0;
    if (fedCount === 0) {
      return {
        status: "confirmed",
        confidence: 0.6,
        evidence_url: fedUrl,
        sources: [fedUrl],
        evidence_snippet: `CourtListener federal RECAP: 0 hits for "${name}" (state civil coverage out of scope).`,
        derived_predicate: "person.litigation.federal_hits",
        derived_value_text: "0",
        derived_value_json: { federal_hits: 0, state_civil_coverage: "out_of_scope" },
      };
    }
    const first = fed.results?.[0];
    const evidenceUrl = first?.absolute_url ? `https://www.courtlistener.com${first.absolute_url}` : fedUrl;
    return {
      status: "contradicted",
      confidence: 0.75,
      evidence_url: evidenceUrl,
      sources: [fedUrl],
      evidence_snippet: `CourtListener federal RECAP: ${fedCount} hit(s); first: ${first?.caseName ?? "case"} (${first?.dateFiled ?? "unknown date"}).`,
      derived_predicate: "person.litigation.federal_hits",
      derived_value_text: String(fedCount),
      derived_value_json: { federal_hits: fedCount },
      reason: "civil_match",
    };
  },
};
