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

export async function extractFromHtml(env: Env, url: string, html: string): Promise<string[]> {
  const { name, parser } = selectParser(url);
  // The "profile" parser requires the async URL-dispatcher path; we skip
  // it here to avoid re-fetching pages discovery just fetched. Other
  // parsers are synchronous and operate on HTML directly.
  if (name === "profile") return [];
  let parsed: ReturnType<typeof parser>;
  try {
    parsed = parser(html, url);
  } catch {
    return [];
  }
  const ids: string[] = [];
  const jobId = `discovery:${crypto.randomUUID()}`;
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
