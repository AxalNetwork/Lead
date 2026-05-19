// Education verifier — checks a person.education claim against the
// institution's directory / commencement program / thesis listing.
// Public-records only. In environments without a configured directory
// fetcher we return `unverifiable` (never `confirmed`) so the UI is
// honest about what we actually observed.


import { fetchPage } from "../../../scraper/fetcher";
import type { Verifier, VerifierResult } from "../types";

// Known directory roots — when a more authoritative endpoint isn't
// available we probe the alumni / commencement page via the in-house
// fetcher (tiered, rate-limited). Hit/miss is signal, never proof.
const DIRECTORIES: Array<{ matcher: RegExp; commencement: (year: number) => string }> = [
  { matcher: /\bMIT\b|massachusetts institute/i, commencement: (y) => `https://commencement.mit.edu/sites/default/files/${y}-program.pdf` },
  { matcher: /stanford/i, commencement: (y) => `https://commencement.stanford.edu/${y}/program` },
  { matcher: /berkeley|UC berkeley|university of california, berkeley/i, commencement: (y) => `https://commencement.berkeley.edu/${y}/list` },
];

export const educationVerifier: Verifier = {
  name: "education",
  version: "0.1.0",
  supports(claim) { return claim.predicate === "person.education"; },
  async verify(env, _personId, claim): Promise<VerifierResult> {
    const p = claim.payload as { institution?: string; degree?: string; ended_year?: number; source_url?: string };
    const institution = (p.institution ?? "").trim();
    const ended_year = typeof p.ended_year === "number" ? p.ended_year : null;
    if (!institution) {
      return { status: "skipped", confidence: 0, reason: "missing_institution" };
    }
    const dir = DIRECTORIES.find((d) => d.matcher.test(institution));
    if (!dir || !ended_year) {
      return {
        status: "unverifiable",
        confidence: 0.3,
        reason: dir ? "missing_ended_year" : "no_directory_match",
        evidence_url: p.source_url ?? null,
      };
    }
    const url = dir.commencement(ended_year);
    try {
      const res = await fetchPage(env, url, { liveOnly: true, timeoutMs: 15_000 });
      if (!res.ok || !res.html) {
        return { status: "unverifiable", confidence: 0.3, reason: `fetch_${res.blockReason ?? "failed"}`, evidence_url: url };
      }
      // Heuristic: exact case-insensitive surname token match in the
      // commencement HTML. Returns `unverifiable` when name is missing
      // from claim payload (we don't synthesize names here).
      const personName = String((p as { person_name?: string }).person_name ?? "").trim();
      if (!personName) {
        return { status: "unverifiable", confidence: 0.3, reason: "missing_person_name", evidence_url: url };
      }
      const found = res.html.toLowerCase().includes(personName.toLowerCase());
      if (found) {
        const idx = res.html.toLowerCase().indexOf(personName.toLowerCase());
        const snippet = res.html.slice(Math.max(0, idx - 80), idx + 200).replace(/\s+/g, " ").trim();
        return {
          status: "confirmed",
          confidence: 0.85,
          evidence_snippet: snippet.slice(0, 500),
          evidence_url: url,
          sources: [url],
          derived_predicate: "person.education.verified",
          derived_value_json: { institution, degree: p.degree ?? null, ended_year },
        };
      }
      return {
        status: "contradicted",
        confidence: 0.6,
        evidence_url: url,
        reason: "name_absent_from_commencement",
        evidence_snippet: `Name not found in ${institution} commencement listing for ${ended_year}.`,
      };
    } catch (e) {
      return { status: "unverifiable", confidence: 0.2, reason: `fetch_error:${(e as Error).message}`, evidence_url: url };
    }
  },
};
