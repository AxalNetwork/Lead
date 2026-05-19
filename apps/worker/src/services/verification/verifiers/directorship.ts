// Directorship verifier — SEC director disclosures (DEF 14A / 8-K)
// when present, Companies House officer lookup for UK-registered orgs
// (via in-house fetcher), then press-release cooccurrence as a soft
// signal.

import { fetchPage } from "../../../scraper/fetcher";
import type { Verifier, VerifierResult } from "../types";

interface ChOfficers { items?: Array<{ name?: string; officer_role?: string; appointed_on?: string }> }

export const directorshipVerifier: Verifier = {
  name: "directorship",
  version: "0.2.0",
  supports(c) { return c.predicate === "person.board_seat"; },
  async verify(env, personId, claim): Promise<VerifierResult> {
    const p = claim.payload as {
      organization_entity_id?: string | null;
      organization_name?: string;
      role?: string | null;
      started_at?: string | null;
      ended_at?: string | null;
      source_url?: string | null;
      person_name?: string | null;
      uk_company_number?: string | null;
    };
    const orgId = p.organization_entity_id ?? null;
    const orgName = p.organization_name ?? "";
    if (!orgId && !orgName) return { status: "skipped", confidence: 0, reason: "missing_org" };

    // 1. SEC DEF 14A / 8-K — strongest signal for US issuers.
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

    // 2. Companies House officer lookup (UK-registered orgs). Cheap,
    //    public, in-house-fetched. Requires a uk_company_number on the
    //    claim or stored as a fact on the org entity.
    let companyNumber: string | null = p.uk_company_number ?? null;
    if (!companyNumber && orgId) {
      try {
        const f = await env.DB.prepare(
          `SELECT value_text FROM facts
            WHERE entity_id = ? AND predicate = 'firm.companies_house_number' AND is_current = 1
            LIMIT 1`,
        ).bind(orgId).first<{ value_text: string }>();
        if (f?.value_text) companyNumber = f.value_text;
      } catch { /* */ }
    }
    // Companies House requires an API key sent as HTTP Basic auth
    // (key as username, empty password). Skip cleanly if unset.
    const chKey = env.COMPANIES_HOUSE_API_KEY;
    if (companyNumber && chKey) {
      const url = `https://api.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}/officers`;
      try {
        const res = await fetchPage(env, url, {
          liveOnly: true,
          timeoutMs: 15_000,
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${btoa(`${chKey}:`)}`,
          },
        });
        if (res.ok && res.html) {
          let body: ChOfficers; try { body = JSON.parse(res.html) as ChOfficers; } catch { body = {}; }
          const personName = (p.person_name ?? "").toLowerCase();
          const match = (body.items ?? []).find((o) => personName && (o.name ?? "").toLowerCase().includes(personName));
          if (match) {
            return {
              status: "confirmed",
              confidence: 0.9,
              evidence_url: url,
              sources: [url],
              evidence_snippet: `Companies House lists ${match.officer_role ?? "officer"}${match.appointed_on ? ` appointed ${match.appointed_on}` : ""}.`,
              derived_predicate: "person.board_seat.verified",
              derived_value_json: { organization_entity_id: orgId, organization_name: orgName, source: "companies_house", company_number: companyNumber },
            };
          }
        }
      } catch { /* fall through */ }
    }

    // 3. Press-release cooccurrence as soft signal.
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
      reason: "no_disclosure_or_press_or_registry",
      evidence_url: p.source_url ?? null,
    };
  },
};
