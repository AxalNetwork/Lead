// Task #3: CourtListener federal & state court case lookups.
//
// CourtListener exposes a public REST API. Anonymous calls are
// rate-limited (5000/day) — enough for our needs. We search the
// `search/` endpoint for the candidate name and turn each docket into
// one `court_case` finding.

import type { Env } from "../../types";

export interface CourtCaseHit {
  caseName: string;
  court: string;
  dateFiled: string;
  docketNumber?: string;
  absolute_url: string;
}

const ENDPOINT = "https://www.courtlistener.com/api/rest/v3/search/";

export async function searchCourtListener(
  _env: Env,
  query: string,
  opts: { limit?: number } = {},
): Promise<{ ok: boolean; hits: CourtCaseHit[]; error?: string }> {
  const limit = Math.min(opts.limit ?? 10, 20);
  const url = `${ENDPOINT}?type=r&q=${encodeURIComponent(`"${query}"`)}&order_by=dateFiled+desc`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, hits: [], error: `http_${res.status}` };
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const hits: CourtCaseHit[] = (data.results ?? []).slice(0, limit).map((r) => ({
      caseName: String(r.caseName ?? r.caption ?? ""),
      court: String(r.court ?? ""),
      dateFiled: String(r.dateFiled ?? ""),
      docketNumber: r.docketNumber ? String(r.docketNumber) : undefined,
      absolute_url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : "",
    })).filter((h) => h.caseName && h.absolute_url);
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: (e as Error).message };
  }
}
