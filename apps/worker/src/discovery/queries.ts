// Site-restricted query generators. Each produces a list of search queries that
// public engines (Brave / Google via Browser Rendering) can answer. We bias
// toward partner / team listings on LinkedIn, Crunchbase, and the firm's own
// site — never logged-in scrapes.

export interface QuerySpec {
  q: string;
  reason: string;
}

export function partnerQueriesForFirm(firmDomain: string): QuerySpec[] {
  const d = firmDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const bare = d.replace(/^www\./, "");
  return [
    { q: `site:linkedin.com/in "${bare}"`, reason: "linkedin_in" },
    { q: `site:linkedin.com/in "partner" "${bare}"`, reason: "linkedin_partner" },
    { q: `site:linkedin.com/in "venture partner" "${bare}"`, reason: "linkedin_venture_partner" },
    { q: `site:crunchbase.com/person "${bare}"`, reason: "crunchbase_person" },
    { q: `site:${d} (team OR people OR partners OR about)`, reason: "self_team" },
    { q: `site:sec.gov "${bare}" Form ADV`, reason: "sec_adv" },
  ];
}

export function personaQueries(persona: string, country?: string): QuerySpec[] {
  const c = country ? ` "${country}"` : "";
  return [
    { q: `site:linkedin.com/in "${persona}"${c}`, reason: "linkedin_persona" },
    { q: `site:crunchbase.com/person "${persona}"${c}`, reason: "crunchbase_persona" },
    { q: `"${persona}"${c} -inurl:(login signup)`, reason: "open_web_persona" },
  ];
}
