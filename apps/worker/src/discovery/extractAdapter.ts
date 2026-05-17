// Task #2: thin bridge so the link-discovery layer feeds the existing
// extraction pipeline. Reuses the registry-based `selectParser` and the
// canonical `insertLead` helper so discovery-sourced pages go through
// exactly the same DNC scrub, dedupe, and lead-merge logic as a normal
// scrape job. A synthetic `discovery:<runId|adhoc>` job id is used so
// the inserted rows are attributable and the cancellation guards still
// behave (they check the job's status; nonexistent ids are treated as
// not-cancelled).

import type { Env } from "../types";
import { selectParser } from "../scraper/parsers";
import { insertLead } from "../scraper/pipeline";

export async function extractFromHtml(env: Env, url: string, html: string, runId?: string | null): Promise<string[]> {
  const { name, parser } = selectParser(url);
  // Every registered parser exposes the same `(html, url) => ParsedLead[]`
  // sync entry, including the "profile" parser which internally routes
  // Crunchbase-person HTML vs personal-site HTML. We reuse the in-hand
  // HTML rather than calling `dispatchProfile` so discovery does not
  // re-fetch pages that the frontier crawler just fetched.
  let parsed: ReturnType<typeof parser>;
  try {
    parsed = parser(html, url);
  } catch {
    return [];
  }
  if (parsed.length === 0) {
    console.log("extractAdapter_zero", JSON.stringify({ url, parser: name }));
  }
  const ids: string[] = [];
  // Tie the synthetic job id to the discovery run when we have one so
  // operators can join discovery_runs ↔ inserted leads via job_id
  // prefix. Falls back to `adhoc` (the case where /api/discovery/crawl
  // pops a frontier row that has no run_id, e.g. a manually-promoted
  // URL from before run tracking existed).
  const jobId = `discovery:${runId ?? "adhoc"}:${crypto.randomUUID()}`;
  for (const lead of parsed) {
    try {
      const id = await insertLead(env, lead, name, jobId, "live");
      if (id) ids.push(id);
    } catch (e) {
      console.warn("extractAdapter_insert_failed", (e as Error).message);
    }
  }
  return ids;
}
