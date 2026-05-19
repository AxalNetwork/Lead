// Bankruptcy verifier.
//
// Source order (highest authority first):
//   1. PACER PCL when PACER_USER + PACER_PASS are set. The PCL
//      ("Public Case Locator") is the authoritative federal index of
//      bankruptcy and district-court parties. Auth is via the
//      pacer.login.uscourts.gov "cso-auth" service which mints a
//      next-gen CSO token; PCL search accepts that token via the
//      X-NEXT-GEN-CSO header.
//   2. CourtListener `court_type=B` (bankruptcy-court RECAP) when
//      COURTLISTENER_TOKEN is set. Coverage is partial but the
//      signal is real and counts as corroboration when PACER
//      misses (e.g. transient PACER auth outage).
//
// Both sources are queried directly via fetch() — PACER login is a
// JSON POST and PCL is a JSON POST, neither benefits from the HTML
// tier ladder in scraper/fetcher and both must NOT be routed through
// a third-party proxy (PACER ToS).

import { fetchPage } from "../../../scraper/fetcher";
import type { Env } from "../../../types";
import type { Verifier, VerifierResult } from "../types";

interface ClRes { results: Array<{ caseName?: string; absolute_url?: string; dateFiled?: string }>; count?: number }

const PACER_LOGIN_URL = "https://pacer.login.uscourts.gov/services/cso-auth";
const PACER_PCL_SEARCH_URL = "https://pcl.uscourts.gov/pcl-public-api/rest/parties/find";

interface PclHit {
  caseTitle?: string;
  caseNumber?: string;
  courtId?: string;
  dateFiled?: string;
  // PCL builds the docket URL from court + case ID.
}
interface PclResponse {
  content?: PclHit[];
  pageInfo?: { totalElements?: number };
}
interface PacerSearch {
  status: "confirmed" | "contradicted" | "unverifiable";
  count: number;
  first?: PclHit;
  reason?: string;
}

function splitName(name: string): { firstName?: string; lastName?: string } {
  const t = name.trim().split(/\s+/);
  if (t.length === 0) return {};
  if (t.length === 1) return { lastName: t[0] };
  return { firstName: t.slice(0, -1).join(" "), lastName: t[t.length - 1] };
}

/**
 * Authenticate against pacer.login.uscourts.gov and return a next-gen
 * CSO token, or null on any failure. Token is single-use per session;
 * callers should obtain a fresh one per verification run.
 */
async function pacerLogin(env: Env): Promise<string | null> {
  if (!env.PACER_USER || !env.PACER_PASS) return null;
  try {
    const r = await fetch(PACER_LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ loginId: env.PACER_USER, password: env.PACER_PASS }),
    });
    if (!r.ok) return null;
    const body = await r.json() as { nextGenCSO?: string; loginResult?: string };
    if (body && body.nextGenCSO && (body.loginResult === "0" || body.loginResult === undefined)) {
      return body.nextGenCSO;
    }
    return null;
  } catch { return null; }
}

/**
 * Query PCL for any bankruptcy-court party matching `name`. Returns
 * normalized hit count + first hit, or unverifiable + reason on any
 * source-side failure (auth, network, parse).
 */
async function pacerSearch(env: Env, name: string): Promise<PacerSearch> {
  const token = await pacerLogin(env);
  if (!token) return { status: "unverifiable", count: 0, reason: "pacer_auth_failed" };
  const { firstName, lastName } = splitName(name);
  if (!lastName) return { status: "unverifiable", count: 0, reason: "pacer_missing_lastname" };
  try {
    const r = await fetch(PACER_PCL_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-NEXT-GEN-CSO": token,
      },
      body: JSON.stringify({
        lastName,
        firstName: firstName ?? "",
        jurisdictionType: "bk", // bankruptcy only
      }),
    });
    if (!r.ok) return { status: "unverifiable", count: 0, reason: `pacer_http_${r.status}` };
    const body = await r.json() as PclResponse;
    const count = body.pageInfo?.totalElements ?? body.content?.length ?? 0;
    if (count === 0) return { status: "confirmed", count: 0 };
    return { status: "contradicted", count, first: body.content?.[0] };
  } catch (e) {
    return { status: "unverifiable", count: 0, reason: `pacer_error:${(e as Error).message}` };
  }
}

export const bankruptcyVerifier: Verifier = {
  name: "bankruptcy",
  version: "0.3.0",
  supports(c) { return c.predicate === "person.bankruptcy_check"; },
  async verify(env, _personId, claim): Promise<VerifierResult> {
    const p = claim.payload as { person_name?: string };
    const name = (p.person_name ?? "").trim();
    if (!name) return { status: "skipped", confidence: 0, reason: "missing_name" };

    // Path 1: PACER PCL (authoritative). Only attempted when creds
    // are configured. Auth/network/HTTP failures fall through to
    // CourtListener so a transient PACER outage doesn't strand the
    // verification — but the returned finding records the PACER
    // failure reason via `sources` for operator visibility.
    let pacerReason: string | null = null;
    if (env.PACER_USER && env.PACER_PASS) {
      const res = await pacerSearch(env, name);
      if (res.status === "confirmed") {
        return {
          status: "confirmed",
          confidence: 0.9,
          evidence_url: PACER_PCL_SEARCH_URL,
          sources: [PACER_PCL_SEARCH_URL],
          evidence_snippet: `PACER PCL bankruptcy search: 0 hits for "${name}".`,
          derived_predicate: "person.bankruptcy.hits",
          derived_value_text: "0",
          reason: "pacer_pcl",
        };
      }
      if (res.status === "contradicted") {
        const f = res.first;
        return {
          status: "contradicted",
          confidence: 0.95,
          evidence_url: PACER_PCL_SEARCH_URL,
          sources: [PACER_PCL_SEARCH_URL],
          evidence_snippet: `PACER PCL: ${res.count} bankruptcy hit(s); first: ${f?.caseTitle ?? "case"} ${f?.caseNumber ?? ""} (${f?.courtId ?? ""}, filed ${f?.dateFiled ?? "unknown"}).`,
          derived_predicate: "person.bankruptcy.hits",
          derived_value_text: String(res.count),
          reason: "pacer_pcl_match",
        };
      }
      pacerReason = res.reason ?? "pacer_unknown";
    } else {
      pacerReason = "pacer_unconfigured";
    }

    // Path 2: CourtListener bankruptcy-court fallback.
    const clToken = env.COURTLISTENER_TOKEN;
    if (!clToken) {
      return { status: "unverifiable", confidence: 0.2, reason: `no_bankruptcy_source_configured (${pacerReason}, courtlistener_unconfigured)` };
    }
    const url = `https://www.courtlistener.com/api/rest/v3/search/?type=r&court_type=B&q=${encodeURIComponent(`"${name}"`)}`;
    try {
      const res = await fetchPage(env, url, {
        liveOnly: true,
        timeoutMs: 15_000,
        expectJson: true,
        headers: { Authorization: `Token ${clToken}`, Accept: "application/json" },
      });
      if (!res.ok || !res.html) {
        return { status: "unverifiable", confidence: 0.2, reason: `cl_fetch_${res.blockReason ?? "failed"} (${pacerReason})`, evidence_url: url };
      }
      let body: ClRes;
      try { body = JSON.parse(res.html) as ClRes; } catch { return { status: "unverifiable", confidence: 0.2, reason: `cl_parse_failed (${pacerReason})`, evidence_url: url }; }
      const count = body.count ?? body.results?.length ?? 0;
      if (count === 0) {
        return {
          status: "confirmed",
          confidence: 0.6,
          evidence_url: url,
          sources: [url],
          evidence_snippet: `CourtListener bankruptcy-court search: 0 hits for "${name}". (PACER status: ${pacerReason}.)`,
          derived_predicate: "person.bankruptcy.hits",
          derived_value_text: "0",
          reason: `courtlistener_b_only (${pacerReason})`,
        };
      }
      const first = body.results?.[0];
      const evidenceUrl = first?.absolute_url ? `https://www.courtlistener.com${first.absolute_url}` : url;
      return {
        status: "contradicted",
        confidence: 0.75,
        evidence_url: evidenceUrl,
        sources: [url],
        evidence_snippet: `CourtListener bankruptcy-court search: ${count} hit(s); first: ${first?.caseName ?? "case"} (${first?.dateFiled ?? "unknown date"}). (PACER status: ${pacerReason}.)`,
        derived_predicate: "person.bankruptcy.hits",
        derived_value_text: String(count),
        reason: "bankruptcy_match",
      };
    } catch (e) {
      return { status: "unverifiable", confidence: 0.2, reason: `cl_error:${(e as Error).message} (${pacerReason})` };
    }
  },
};
