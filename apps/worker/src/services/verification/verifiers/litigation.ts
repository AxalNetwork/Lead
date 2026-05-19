// Litigation verifier — queries CourtListener REST when COURTLISTENER_TOKEN
// is configured; otherwise returns unverifiable so the UI is honest.
// The claim is a "no_open_litigation" assertion (or absent claim, in
// which case we always emit a finding row so the operator sees what
// the public record says).


import type { Verifier, VerifierResult } from "../types";

interface ClRes { results: Array<{ caseName?: string; absolute_url?: string; dateFiled?: string }>; count?: number }

export const litigationVerifier: Verifier = {
  name: "litigation",
  version: "0.1.0",
  supports(c) { return c.predicate === "person.litigation_check"; },
  async verify(env, _personId, claim): Promise<VerifierResult> {
    const p = claim.payload as { person_name?: string };
    const name = (p.person_name ?? "").trim();
    if (!name) return { status: "skipped", confidence: 0, reason: "missing_name" };
    const token = (env as unknown as { COURTLISTENER_TOKEN?: string }).COURTLISTENER_TOKEN;
    if (!token) {
      return { status: "unverifiable", confidence: 0.2, reason: "courtlistener_unconfigured" };
    }
    const url = `https://www.courtlistener.com/api/rest/v3/search/?type=r&q=${encodeURIComponent(`"${name}"`)}`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
      if (!res.ok) {
        return { status: "unverifiable", confidence: 0.2, reason: `cl_http_${res.status}` };
      }
      const body = (await res.json()) as ClRes;
      const count = body.count ?? body.results?.length ?? 0;
      if (count === 0) {
        return {
          status: "confirmed",
          confidence: 0.7,
          evidence_url: url,
          evidence_snippet: `CourtListener returned 0 federal-civil hits for "${name}".`,
          derived_predicate: "person.litigation.federal_hits",
          derived_value_text: "0",
        };
      }
      const first = body.results?.[0];
      const evidenceUrl = first?.absolute_url ? `https://www.courtlistener.com${first.absolute_url}` : url;
      return {
        status: "contradicted",
        confidence: 0.75,
        evidence_url: evidenceUrl,
        evidence_snippet: `CourtListener returned ${count} hit(s); first: ${first?.caseName ?? "case"} (${first?.dateFiled ?? "unknown date"}).`,
        derived_predicate: "person.litigation.federal_hits",
        derived_value_text: String(count),
        reason: "federal_civil_match",
      };
    } catch (e) {
      return { status: "unverifiable", confidence: 0.2, reason: `cl_error:${(e as Error).message}` };
    }
  },
};
