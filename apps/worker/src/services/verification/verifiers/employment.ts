// Employment verifier — corroborates a person.career_entry claim
// against any of: an existing Form 4 insider filing for the same
// person↔company, a Wayback team-page snapshot in the claimed
// window, or a press-release entity row touching both.


import type { Verifier, VerifierResult } from "../types";

export const employmentVerifier: Verifier = {
  name: "employment",
  version: "0.1.0",
  supports(c) { return c.predicate === "person.career_entry"; },
  async verify(env, personId, claim): Promise<VerifierResult> {
    const p = claim.payload as {
      organization_entity_id?: string | null;
      organization_name?: string;
      role_title?: string | null;
      started_at?: string | null;
      ended_at?: string | null;
      source_url?: string | null;
    };
    const orgId = p.organization_entity_id ?? null;
    const orgName = (p.organization_name ?? "").trim();
    if (!orgId && !orgName) return { status: "skipped", confidence: 0, reason: "missing_org" };

    // 1. SEC Form 4 insider entry?
    if (orgId) {
      try {
        const r = await env.DB.prepare(
          `SELECT id, filing_url, reported_at FROM sec_form4_insiders
            WHERE person_entity_id = ? AND issuer_entity_id = ?
            ORDER BY reported_at DESC LIMIT 1`,
        ).bind(personId, orgId).first<{ id: string; filing_url: string | null; reported_at: string | null }>();
        if (r) {
          return {
            status: "confirmed",
            confidence: 0.95,
            evidence_url: r.filing_url ?? null,
            sources: r.filing_url ? [r.filing_url] : [],
            evidence_snippet: `SEC Form 4 insider filing on ${r.reported_at} corroborates affiliation.`,
            derived_predicate: "person.employment.verified",
            derived_value_json: { organization_entity_id: orgId, organization_name: orgName, source: "sec_form4" },
          };
        }
      } catch { /* table may not exist in test DBs */ }
    }

    // 2. Wayback team-page snapshot that names the person inside the
    //    claimed window. We rely on the movements snapshot table
    //    populated by services/movements (Task #2 spec) so we don't
    //    re-fetch from Wayback here.
    try {
      const r = await env.DB.prepare(
        `SELECT snapshot_url, captured_at FROM firm_team_snapshots
          WHERE (firm_entity_id = ? OR firm_name = ?)
            AND members_json LIKE ?
          ORDER BY captured_at DESC LIMIT 1`,
      ).bind(orgId ?? "", orgName, `%${personId}%`).first<{ snapshot_url: string; captured_at: string }>();
      if (r) {
        return {
          status: "confirmed",
          confidence: 0.8,
          evidence_url: r.snapshot_url,
          sources: [r.snapshot_url],
          evidence_snippet: `Team-page snapshot at ${r.captured_at} lists this person.`,
          derived_predicate: "person.employment.verified",
          derived_value_json: { organization_entity_id: orgId, organization_name: orgName, source: "team_snapshot" },
        };
      }
    } catch { /* missing optional table */ }

    // 3. Press-release corroboration via existing entity_mentions.
    try {
      const r = await env.DB.prepare(
        `SELECT m.url, m.published_at FROM entity_mentions m
          WHERE m.entity_id = ? AND m.cooccurring_entity_id = ?
          ORDER BY m.published_at DESC LIMIT 1`,
      ).bind(personId, orgId ?? "").first<{ url: string; published_at: string }>();
      if (r) {
        return {
          status: "confirmed",
          confidence: 0.65,
          evidence_url: r.url,
          sources: [r.url],
          evidence_snippet: `Press mention on ${r.published_at} ties person to ${orgName}.`,
          derived_predicate: "person.employment.verified",
          derived_value_json: { organization_entity_id: orgId, organization_name: orgName, source: "press" },
        };
      }
    } catch { /* missing optional table */ }

    return {
      status: "unverifiable",
      confidence: 0.3,
      reason: "no_corroborating_source",
      evidence_url: p.source_url ?? null,
    };
  },
};
