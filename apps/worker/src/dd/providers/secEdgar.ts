// Task #3: SEC EDGAR full-text search for enforcement actions.
//
// EDGAR's full-text-search endpoint accepts a free-form query and
// returns recent filings. We use it to surface enforcement releases
// (litigation releases, admin proceedings) that mention the entity by
// name. The result count is the signal; each hit becomes one
// `enforcement` finding. No API key required, but SEC asks every
// caller to identify itself via User-Agent.

import type { Env } from "../../types";

export interface SecEnforcementHit {
  accession: string;
  form: string;        // "LITIGATION-RELEASE" | "AAER" | "8-K" | ...
  filed_at: string;    // ISO date
  title: string;
  url: string;
}

const FTS_ENDPOINT = "https://efts.sec.gov/LATEST/search-index";

export async function searchSecEnforcement(
  env: Env,
  query: string,
  opts: { limit?: number } = {},
): Promise<{ ok: boolean; hits: SecEnforcementHit[]; error?: string }> {
  const limit = opts.limit ?? 10;
  const ua = env.SEC_EDGAR_UA ?? "AIDataSignal/1.0 contact@aidatasignal.com";
  // Bias the query toward enforcement-related forms so 10-K mentions don't dominate.
  const q = encodeURIComponent(`"${query}"`);
  const forms = encodeURIComponent("LITIGATION RELEASE,AAER,ADMINISTRATIVE PROCEEDING");
  const url = `${FTS_ENDPOINT}?q=${q}&forms=${forms}&dateRange=custom&startdt=2010-01-01&enddt=${new Date().toISOString().slice(0,10)}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": ua, "accept": "application/json" } });
    if (!res.ok) return { ok: false, hits: [], error: `http_${res.status}` };
    const data = (await res.json()) as { hits?: { hits?: Array<{ _id?: string; _source?: Record<string, unknown> }> } };
    const raw = data?.hits?.hits ?? [];
    const hits: SecEnforcementHit[] = raw.slice(0, limit).map((h) => {
      const src = (h._source ?? {}) as Record<string, unknown>;
      const accession = String(src.adsh ?? h._id ?? "");
      const accNoDash = accession.replace(/-/g, "");
      const ciks = (src.ciks as unknown[]) ?? [];
      const names = (src.display_names as unknown[]) ?? [];
      const cik = String(ciks[0] ?? "");
      const display = String(names[0] ?? src.file_type ?? "Enforcement filing");
      return {
        accession,
        form: String(src.file_type ?? src.form ?? ""),
        filed_at: String(src.file_date ?? ""),
        title: display,
        url: cik && accNoDash ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${accession}-index.html`
                              : `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}`,
      };
    }).filter((h) => h.accession);
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: (e as Error).message };
  }
}
