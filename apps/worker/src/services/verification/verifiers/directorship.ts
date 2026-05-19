// Directorship verifier — corroborates a person.board_seat claim against
// SEC DEF 14A / 8-K board-disclosure rows when we have them, falling
// back to companies-house style state-registry hits.


import type { Verifier, VerifierResult } from "../types";

export const directorshipVerifier: Verifier = {
  name: "directorship",
  version: "0.1.0",
  supports(c) { return c.predicate === "person.board_seat"; },
  async verify(env, personId, claim): Promise<VerifierResult> {
    const p = claim.payload as {
      organization_entity_id?: string | null;
      organization_name?: string;
      role?: string | null;
      started_at?: string | null;
      ended_at?: string | null;
      source_url?: string | null;
    };
    const orgId = p.organization_entity_id ?? null;
    const orgName = p.organization_name ?? "";
    if (!orgId && !orgName) return { status: "skipped", confidence: 0, reason: "missing_org" };

    // SEC DEF 14A / 8-K board disclosures — sec_director_filings (if present).
    if (orgId) {
      try {
        const r = await env.DB.prepare(
          `SELECT filing_url, reported_at FROM sec_director_filings
            WHERE person_entity_id = ? AND issuer_entity_id = ?
            ORDER BY reported_at DESC LIMIT 1`,
        ).bind(personId, orgId).first<{ filing_url: string; reported_at: string }>();
        if (r) {
          return {
            status: "confirmed",
            confidence: 0.95,
            evidence_url: r.filing_url,
            sources: [r.filing_url],
            evidence_snippet: `SEC director disclosure filed ${r.reported_at}.`,
            derived_predicate: "person.board_seat.verified",
            derived_value_json: { organization_entity_id: orgId, organization_name: orgName, source: "sec" },
          };
        }
      } catch { /* optional table */ }
    }

    // Press-release cooccurrence as soft signal.
    try {
      const r = await env.DB.prepare(
        `SELECT url, published_at FROM entity_mentions
          WHERE entity_id = ? AND cooccurring_entity_id = ?
            AND lower(snippet) LIKE '%board%'
          ORDER BY published_at DESC LIMIT 1`,
      ).bind(personId, orgId ?? "").first<{ url: string; published_at: string }>();
      if (r) {
        return {
          status: "confirmed",
          confidence: 0.55,
          evidence_url: r.url,
          sources: [r.url],
          evidence_snippet: `Press mention of board appointment on ${r.published_at}.`,
          derived_predicate: "person.board_seat.verified",
          derived_value_json: { organization_entity_id: orgId, organization_name: orgName, source: "press" },
        };
      }
    } catch { /* optional table */ }

    return {
      status: "unverifiable",
      confidence: 0.3,
      reason: "no_disclosure_or_press",
      evidence_url: p.source_url ?? null,
    };
  },
};
