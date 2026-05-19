// Public registry probes. Each function returns zero-or-more candidate rows
// (without persisting them). Failures are swallowed and logged — registries
// regularly rate-limit anonymous traffic.

import type { Env } from "../types";

export interface RegistryHit {
  url: string;
  title: string;
  snippet: string;
  source: string;
  org?: string;
  name?: string;
}

async function safeJson<T>(p: Promise<Response>): Promise<T | null> {
  try {
    const r = await p;
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function probeSecEdgar(env: Env, firm: string): Promise<RegistryHit[]> {
  // SEC full-text search returns matches across filings (incl. ADVs).
  const ua = env.SEC_EDGAR_UA ?? "AIDataSignal/1.0 contact@aidatasignal.com";
  type Resp = { hits?: { hits?: Array<{ _id: string; _source: { display_names?: string[]; form?: string } }> } };
  const data = await safeJson<Resp>(
    fetch(`https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(firm)}%22&forms=ADV`, {
      headers: { "User-Agent": ua, Accept: "application/json" },
    }),
  );
  const out: RegistryHit[] = [];
  for (const h of data?.hits?.hits ?? []) {
    const id = h._id;
    out.push({
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${encodeURIComponent(id)}`,
      title: (h._source.display_names ?? []).join(", "),
      snippet: `Form ${h._source.form ?? "?"}`,
      source: "sec_edgar",
      org: (h._source.display_names ?? [])[0],
    });
  }
  return out.slice(0, 5);
}

export async function probeOpenCorporates(_env: Env, firm: string): Promise<RegistryHit[]> {
  // Task #5: the keyless OpenCorporates v0.4 JSON API was removed when the
  // 13 paid third-party APIs were ripped out. The crawler's openCorporates
  // SiteAdapter parses public company pages via the in-house fetcher when
  // ingestion lands on opencorporates.com URLs. For discovery breadcrumbs
  // we now point at the public search page (matching probeUkCompaniesHouse
  // / probeEuTransparency), keeping discovery off the direct-API surface.
  return [
    {
      url: `https://opencorporates.com/companies?q=${encodeURIComponent(firm)}&utf8=%E2%9C%93`,
      title: `OpenCorporates search: ${firm}`,
      snippet: "Open in browser to view registrations",
      source: "opencorporates",
      org: firm,
    },
  ];
}

export async function probeUkCompaniesHouse(_env: Env, firm: string): Promise<RegistryHit[]> {
  // Task #5: the key-gated UK_CH API was removed. We now point at the
  // public find-and-update search page as a discovery breadcrumb,
  // matching the probeEuTransparency pattern.
  return [
    {
      url: `https://find-and-update.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(firm)}`,
      title: `UK Companies House search: ${firm}`,
      snippet: "Open in browser to view registrations",
      source: "uk_companies_house",
      org: firm,
    },
  ];
}

export async function probeBodacc(_env: Env, firm: string): Promise<RegistryHit[]> {
  // BODACC public dataset on data.gouv.fr.
  type Resp = { records?: Array<{ fields: { commercant?: string; departement_nom_officiel?: string; titre?: string } }> };
  const data = await safeJson<Resp>(
    fetch(`https://bodacc-datadila.opendatasoft.com/api/records/1.0/search/?dataset=annonces-commerciales&q=${encodeURIComponent(firm)}&rows=5`),
  );
  const out: RegistryHit[] = [];
  for (const r of data?.records ?? []) {
    out.push({
      url: `https://bodacc-datadila.opendatasoft.com/explore/dataset/annonces-commerciales/?q=${encodeURIComponent(firm)}`,
      title: r.fields.commercant ?? r.fields.titre ?? firm,
      snippet: r.fields.departement_nom_officiel ?? "",
      source: "bodacc",
      org: r.fields.commercant,
    });
  }
  return out;
}

export async function probeEuTransparency(_env: Env, firm: string): Promise<RegistryHit[]> {
  // EU Transparency Register has a public search page; we point to the URL
  // rather than scrape the results, which is enough as a discovery breadcrumb.
  return [
    {
      url: `https://ec.europa.eu/transparencyregister/public/consultation/search.do?action=search&searchType=COMPLEX&name=${encodeURIComponent(firm)}`,
      title: `EU Transparency Register: ${firm}`,
      snippet: "Open in browser to view registrations",
      source: "eu_transparency",
      org: firm,
    },
  ];
}

export async function probeAllRegistries(env: Env, firm: string): Promise<RegistryHit[]> {
  const settled = await Promise.allSettled([
    probeSecEdgar(env, firm),
    probeOpenCorporates(env, firm),
    probeUkCompaniesHouse(env, firm),
    probeBodacc(env, firm),
    probeEuTransparency(env, firm),
  ]);
  const out: RegistryHit[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  return out;
}
