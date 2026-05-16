import type { FirmlistImporter } from "./types";
import { importFirms as airtableShare } from "./airtable_share";
import { importFirms as googleSheets } from "./google_sheets";
import { importFirms as mercury } from "./mercury";
import { importFirms as openvc } from "./openvc";
import { importFirms as nfxSignal } from "./nfx_signal";
import { importFirms as folkApp } from "./folk_app";
import { importFirms as folk } from "./folk";
import { importFirms as nycFounderGuide } from "./nyc_founder_guide";
import { importFirms as versatileVc } from "./versatilevc";
import { importFirms as genericCsvUrl } from "./generic_csv_url";
import { importFirms as genericJsonld } from "./generic_jsonld";

export const FIRMLIST_IMPORTERS: Record<string, FirmlistImporter> = {
  airtable_share: airtableShare,
  google_sheets: googleSheets,
  mercury,
  openvc,
  nfx_signal: nfxSignal,
  folk,
  folk_app: folkApp,
  nyc_founder_guide: nycFounderGuide,
  versatilevc: versatileVc,
  generic_csv_url: genericCsvUrl,
  generic_jsonld: genericJsonld,
};

export type FirmlistImporterName = keyof typeof FIRMLIST_IMPORTERS;

/**
 * Auto-detect which importer to use based on URL shape. Falls back to
 * `generic_jsonld` so any URL still has a chance at structured extraction.
 */
export function selectImporter(url: string): { name: string; importer: FirmlistImporter } {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname.toLowerCase();
  } catch {
    return { name: "generic_jsonld", importer: genericJsonld };
  }

  if (host === "airtable.com") return { name: "airtable_share", importer: airtableShare };
  if (host === "docs.google.com" && /\/spreadsheets\//.test(path)) return { name: "google_sheets", importer: googleSheets };
  if (host === "mercury.com") return { name: "mercury", importer: mercury };
  if (host === "openvc.app" || host === "api.openvc.app") return { name: "openvc", importer: openvc };
  if (host.endsWith("signal.nfx.com") || host.endsWith("nfx.com")) return { name: "nfx_signal", importer: nfxSignal };
  if (host === "folk.app" || host.endsWith(".folk.app")) {
    // Folk *share* URLs (`/shared/{slug}-{id}`) get the dedicated full-API
    // importer; everything else on folk.app falls back to the legacy
    // best-effort scraper.
    if (/^\/shared\//.test(path)) return { name: "folk", importer: folk };
    return { name: "folk_app", importer: folkApp };
  }
  if (host.includes("nycfounderguide") || host === "nycfounderguide.com") {
    return { name: "nyc_founder_guide", importer: nycFounderGuide };
  }
  if (host.includes("versatilevc")) return { name: "versatilevc", importer: versatileVc };
  if (/\.(csv|tsv)(\?|#|$)/.test(url)) return { name: "generic_csv_url", importer: genericCsvUrl };
  return { name: "generic_jsonld", importer: genericJsonld };
}

export type { FirmCandidate, FirmlistImportResult, FirmlistImporter } from "./types";
