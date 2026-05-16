// Task #3: UK Companies House disqualified directors lookup.
//
// Companies House provides a public search endpoint for disqualified
// officers. Requires an API key (UK_CH_API_KEY) — without it the
// provider is skipped silently. Auth is HTTP Basic with the key as the
// username and a blank password.

import type { Env } from "../../types";

export interface DisqualifiedHit {
  officer_id: string;
  name: string;
  date_of_birth?: string;
  disqualification_url: string;
}

const ENDPOINT = "https://api.company-information.service.gov.uk/search/disqualified-officers";

export async function searchUkDisqualified(
  env: Env,
  query: string,
  opts: { limit?: number } = {},
): Promise<{ ok: boolean; hits: DisqualifiedHit[]; error?: string; skipped?: boolean }> {
  const key = env.UK_CH_API_KEY;
  if (!key) return { ok: true, hits: [], skipped: true };
  const limit = Math.min(opts.limit ?? 10, 20);
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&items_per_page=${limit}`;
  const auth = btoa(`${key}:`);
  try {
    const res = await fetch(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" } });
    if (!res.ok) return { ok: false, hits: [], error: `http_${res.status}` };
    const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
    const hits: DisqualifiedHit[] = (data.items ?? []).map((r) => {
      const links = (r.links ?? {}) as Record<string, string>;
      const dob = r.date_of_birth as Record<string, number> | undefined;
      return {
        officer_id: String((r as { officer_id?: string }).officer_id ?? r.title ?? ""),
        name: String(r.title ?? ""),
        date_of_birth: dob ? `${dob.year}-${String(dob.month ?? 1).padStart(2,"0")}-${String(dob.day ?? 1).padStart(2,"0")}` : undefined,
        disqualification_url: links.self ? `https://find-and-update.company-information.service.gov.uk${links.self}` : "",
      };
    }).filter((h) => h.name && h.disqualification_url);
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: (e as Error).message };
  }
}
