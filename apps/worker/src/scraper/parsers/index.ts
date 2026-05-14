import type { ParsedLead } from "../../types";
import { parse as parseGeneric } from "./generic";
import { parse as parseLinktree } from "./linktree";
import { parse as parseBeacons } from "./beacons";
import { parse as parseCrunchbase } from "./crunchbase";
import { parse as parsePitchbook } from "./pitchbook";
import { parse as parseSecEdgar } from "./sec-edgar";
import { parse as parseOpenCorporates } from "./opencorporates";
import { parse as parseGovRegistry } from "./gov-registry";
import { parse as parsePersonalSite } from "./personal-site";
import { parse as parseProfile } from "./profile";

export type ParserFn = (html: string, url: string) => ParsedLead[];

export const PARSERS: Record<string, ParserFn> = {
  generic: parseGeneric,
  linktree: parseLinktree,
  beacons: parseBeacons,
  crunchbase: parseCrunchbase,
  pitchbook: parsePitchbook,
  "sec-edgar": parseSecEdgar,
  opencorporates: parseOpenCorporates,
  "gov-registry": parseGovRegistry,
  "personal-site": parsePersonalSite,
  profile: parseProfile,
};

/**
 * Pick the right parser based on the URL host. Falls back to the new
 * profile-aware dispatcher (Task #18) which handles personal sites and
 * Crunchbase person/org pages. Note: pipeline.ts ALSO short-circuits
 * profile-shaped URLs through `dispatchProfile` before fetch — this
 * sync registry only matters for callers that already have HTML in hand
 * (e.g., the `linktree` outbound-fanout path).
 */
export function selectParser(url: string): { name: string; parser: ParserFn } {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { name: "profile", parser: parseProfile };
  }
  if (host.endsWith("linktr.ee") || host.endsWith("linktree.com")) return { name: "linktree", parser: parseLinktree };
  if (host.endsWith("beacons.ai") || host.endsWith("beacons.page")) return { name: "beacons", parser: parseBeacons };
  if (host.endsWith("crunchbase.com")) return { name: "profile", parser: parseProfile };
  if (host.endsWith("pitchbook.com")) return { name: "pitchbook", parser: parsePitchbook };
  if (host.endsWith("sec.gov") || host.endsWith("adviserinfo.sec.gov")) return { name: "sec-edgar", parser: parseSecEdgar };
  if (host.endsWith("opencorporates.com")) return { name: "opencorporates", parser: parseOpenCorporates };
  if (host.endsWith("companieshouse.gov.uk") || host.endsWith("company-information.service.gov.uk")) {
    return { name: "gov-registry", parser: parseGovRegistry };
  }
  return { name: "profile", parser: parseProfile };
}

export { parseGeneric };
export { parseCrunchbase as parseCrunchbaseLegacy };
