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

export async function probeOpenCorporates(env: Env, firm: string): Promise<RegistryHit[]> {
  type Resp = { results?: { companies?: Array<{ company: { name: string; jurisdiction_code: string; opencorporates_url: string } }> } };
  const key = env.OPENCORPORATES_API_KEY ? `&api_token=${env.OPENCORPORATES_API_KEY}` : "";
  const data = await safeJson<Resp>(
    fetch(`https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(firm)}${key}`),
  );
  const out: RegistryHit[] = [];
  for (const c of data?.results?.companies ?? []) {
    out.push({
      url: c.company.opencorporates_url,
      title: c.company.name,
      snippet: c.company.jurisdiction_code,
      source: "opencorporates",
      org: c.company.name,
    });
  }
  return out.slice(0, 5);
}

export async function probeUkCompaniesHouse(env: Env, firm: string): Promise<RegistryHit[]> {
  if (!env.UK_CH_API_KEY) return [];
  type Resp = { items?: Array<{ title: string; company_number: string; address_snippet?: string }> };
  const data = await safeJson<Resp>(
    fetch(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(firm)}`, {
      headers: { Authorization: "Basic " + btoa(env.UK_CH_API_KEY + ":") },
    }),
  );
  const out: RegistryHit[] = [];
  for (const it of data?.items ?? []) {
    out.push({
      url: `https://find-and-update.company-information.service.gov.uk/company/${it.company_number}`,
      title: it.title,
      snippet: it.address_snippet ?? "",
      source: "uk_companies_house",
      org: it.title,
    });
  }
  return out.slice(0, 5);
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
