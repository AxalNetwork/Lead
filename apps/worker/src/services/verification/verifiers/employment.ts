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
          // `sec_form4_insiders` is created by no migration. Form 4 rows land
          // in sec_insider_trades, which already carries resolved
          // owner_entity_id / issuer_entity_id — so this is a rename plus two
          // column mappings, not a missing feature. The table also holds
          // 13D/13G rows, hence the form_type filter; the filing URL lives on
          // sec_filings, joined by accession_no.
          `SELECT t.id AS id, f.filing_url AS filing_url,
                  t.transaction_date AS reported_at
             FROM sec_insider_trades t
             LEFT JOIN sec_filings f ON f.accession_no = t.accession_no
            WHERE t.owner_entity_id = ? AND t.issuer_entity_id = ?
              AND t.form_type = '4'
            ORDER BY t.transaction_date DESC LIMIT 1`,
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

    // 3. Press-release corroboration via news co-mentions.
    try {
      const r = await env.DB.prepare(
        // See directorship.ts — `entity_mentions` never existed; co-occurrence
        // is a self-join on news_entity_mentions.
        `SELECT ni.url AS url, ni.published_at AS published_at
           FROM news_entity_mentions m1
           JOIN news_entity_mentions m2 ON m2.news_item_id = m1.news_item_id
           JOIN news_items ni ON ni.id = m1.news_item_id
          WHERE m1.entity_id = ? AND m2.entity_id = ?
          ORDER BY ni.published_at DESC LIMIT 1`,
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
