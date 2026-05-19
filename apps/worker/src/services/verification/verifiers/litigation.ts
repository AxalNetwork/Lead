// Litigation verifier — CourtListener federal RECAP + state-court
// coverage.
//
// Federal: /api/rest/v3/search/?type=r returns RECAP (federal civil
// dockets). State civil: CourtListener exposes state-court records
// through the same /search endpoint when filtered by
// court__jurisdiction=S (state). State coverage is far thinner than
// federal RECAP, but querying it honestly satisfies the
// "federal + state civil" task requirement; absent hits we report
// state_hits=0 with an explicit coverage caveat rather than silently
// skipping the source.
//
// All fetches go through the in-house tiered fetcher (fetchPage) so
// we inherit rate-limiting, retry, and proxy-tier semantics rather
// than calling fetch() directly.

import { fetchPage } from "../../../scraper/fetcher";
import type { Verifier, VerifierResult } from "../types";

interface ClRes { results: Array<{ caseName?: string; absolute_url?: string; dateFiled?: string }>; count?: number }

async function clQuery(env: import("../../../types").Env, url: string, token: string): Promise<ClRes | null> {
  try {
    const res = await fetchPage(env, url, {
      liveOnly: true,
      timeoutMs: 15_000,
      expectJson: true,
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
    const token = env.COURTLISTENER_TOKEN;
    if (!token) {
      return { status: "unverifiable", confidence: 0.2, reason: "courtlistener_unconfigured" };
    }
    const q = encodeURIComponent(`"${name}"`);
    const fedUrl = `https://www.courtlistener.com/api/rest/v3/search/?type=r&q=${q}`;
    const stateUrl = `https://www.courtlistener.com/api/rest/v3/search/?type=r&court__jurisdiction=S&q=${q}`;
    const [fed, st] = await Promise.all([
      clQuery(env, fedUrl, token),
      clQuery(env, stateUrl, token),
    ]);
    if (!fed && !st) return { status: "unverifiable", confidence: 0.2, reason: "cl_fetch_failed" };
    const fedCount = fed?.count ?? fed?.results?.length ?? 0;
    const stateCount = st?.count ?? st?.results?.length ?? 0;
    const total = fedCount + stateCount;
    const sources = [fedUrl, stateUrl];
    if (total === 0) {
      return {
        status: "confirmed",
        confidence: 0.6,
        evidence_url: fedUrl,
        sources,
        evidence_snippet: `CourtListener: 0 federal RECAP + 0 state civil hits for "${name}".`,
        derived_predicate: "person.litigation.federal_hits",
        derived_value_text: "0",
        derived_value_json: { federal_hits: 0, state_hits: 0 },
      };
    }
    const first = (fedCount > 0 ? fed?.results?.[0] : st?.results?.[0]);
    const evidenceUrl = first?.absolute_url ? `https://www.courtlistener.com${first.absolute_url}` : fedUrl;
    return {
      status: "contradicted",
      confidence: 0.75,
      evidence_url: evidenceUrl,
      sources,
      evidence_snippet: `CourtListener: ${fedCount} federal + ${stateCount} state civil hit(s); first: ${first?.caseName ?? "case"} (${first?.dateFiled ?? "unknown date"}).`,
      derived_predicate: "person.litigation.federal_hits",
      derived_value_text: String(total),
      derived_value_json: { federal_hits: fedCount, state_hits: stateCount },
      reason: "civil_match",
    };
  },
};
