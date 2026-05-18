// Task #3 / Task #5: UK Companies House disqualified directors lookup.
//
// The paid UK_CH_API_KEY-authenticated path was removed in Task #5; this
// module now uses the public find-and-update HTML search page through the
// in-house fetcher and parses officer rows out of the rendered HTML.
// Empty result lists are surfaced as `ok: true, hits: []` so callers can
// distinguish "no match" from "provider error".

import type { Env } from "../../types";
import { fetchPage } from "../../scraper/fetcher";

export interface DisqualifiedHit {
  officer_id: string;
  name: string;
  date_of_birth?: string;
  disqualification_url: string;
}

const SEARCH_URL = "https://find-and-update.company-information.service.gov.uk/search/disqualified-officers";

// The HTML rows look like:
//   <li class="type-disqualified-officer"> ... <a href="/disqualified-officers/natural/<id>">NAME</a> ...
const OFFICER_ROW_RE = /<a[^>]+href="(\/disqualified-officers\/natural\/([^"]+))"[^>]*>([^<]+)<\/a>([\s\S]{0,400}?)<\/li>/gi;
const DOB_RE = /Date of birth:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i;

function parseDob(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const d = new Date(label);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export async function searchUkDisqualified(
  env: Env,
  query: string,
  opts: { limit?: number } = {},
): Promise<{ ok: boolean; hits: DisqualifiedHit[]; error?: string; skipped?: boolean }> {
  const limit = Math.min(opts.limit ?? 10, 20);
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetchPage(env, url, { liveOnly: true, minIntervalMs: 4000 });
    if (!res.ok || !res.html) return { ok: false, hits: [], error: res.blockReason ?? `http_${res.status}` };
    const hits: DisqualifiedHit[] = [];
    let m: RegExpExecArray | null;
    while ((m = OFFICER_ROW_RE.exec(res.html)) && hits.length < limit) {
      const officerHref = m[1];
      const officerId = m[2];
      const name = m[3].trim();
      const tail = m[4];
      const dobLabel = DOB_RE.exec(tail)?.[1];
      hits.push({
        officer_id: officerId,
        name,
        date_of_birth: parseDob(dobLabel),
        disqualification_url: `https://find-and-update.company-information.service.gov.uk${officerHref}`,
      });
    }
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: (e as Error).message };
  }
}
