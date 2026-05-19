// Task #18: Delaware Certificate of Incorporation exhibit fetcher.
//
// Delaware's corporate filings API is paid (and rate-limited). When
// `DELAWARE_COI_API_URL` is unset we return a documented "unconfigured"
// result rather than silently degrading — mirrors the PACER pattern
// established by Task #14's bankruptcy verifier.
//
// When configured, this hits a generic JSON endpoint with the company
// name and expects { coi_html, source_url } back. The same parser
// (`extractPreferredStack`) is then used as the S-1 path.

import type { Env } from "../../types";
import { fetchPage } from "../../scraper/fetcher";
import { extractPreferredStack, type PreferredStackExtraction } from "./preferredSeriesParser";

export interface DelawareCoiResult {
  status: "extracted" | "unconfigured" | "not_found" | "error";
  reason?: string;
  source_url?: string;
  extraction?: PreferredStackExtraction;
}

interface CoiEnv {
  DELAWARE_COI_API_URL?: string;
  DELAWARE_COI_API_KEY?: string;
}

export async function fetchDelawareCoi(env: Env, companyName: string): Promise<DelawareCoiResult> {
  const e = env as unknown as CoiEnv;
  if (!e.DELAWARE_COI_API_URL || !e.DELAWARE_COI_API_KEY) {
    return { status: "unconfigured", reason: "delaware_coi_unconfigured" };
  }
  const url = `${e.DELAWARE_COI_API_URL}?name=${encodeURIComponent(companyName)}`;
  try {
    const res = await fetchPage(env, url, {
      method: "GET",
      headers: { Authorization: `Bearer ${e.DELAWARE_COI_API_KEY}` },
      expectJson: true,
      liveOnly: true,
      skipPolicy: true,
    });
    if (!res.ok) {
      return { status: res.status === 404 ? "not_found" : "error", reason: `http_${res.status}` };
    }
    let body: { coi_html?: string; source_url?: string };
    try { body = JSON.parse(res.html) as { coi_html?: string; source_url?: string }; }
    catch { return { status: "error", reason: "invalid_json_response" }; }
    if (!body.coi_html) return { status: "not_found", reason: "no_coi_html" };
    const extraction = extractPreferredStack(body.coi_html, { companyName });
    return { status: "extracted", source_url: body.source_url, extraction };
  } catch (err) {
    return { status: "error", reason: (err as Error).message.slice(0, 200) };
  }
}
