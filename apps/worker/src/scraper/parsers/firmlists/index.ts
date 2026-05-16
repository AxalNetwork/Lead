import type { FirmlistImporter } from "./types";
import { importFirms as airtableShare } from "./airtable_share";
import { importFirms as airtable } from "./airtable";
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
// Task #2: structured aggregator importers.
import { importFirms as vcsheet } from "./aggregators/vcsheet";
import { importFirms as vcstack } from "./aggregators/vcstack";
import { importFirms as failory } from "./aggregators/failory";
import { importFirms as landscapeVc } from "./aggregators/landscape_vc";
import { importFirms as climatescape } from "./aggregators/climatescape";
import { importFirms as mountsideVentures } from "./aggregators/mountside_ventures";
import { importFirms as foundersNextMove } from "./aggregators/founders_next_move";
// Task #3: regional / long-tail / Wikipedia / generic fallback.
import { importFirms as jvca } from "./aggregators/jvca";
import { importFirms as mapOfTheMoney } from "./aggregators/map_of_the_money";
import { importFirms as goldenEggCheck } from "./aggregators/golden_egg_check";
import { importFirms as wikipedia } from "./aggregators/wikipedia";
import { importFirms as genericHtml } from "./aggregators/generic_html";

export const FIRMLIST_IMPORTERS: Record<string, FirmlistImporter> = {
  airtable,
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
  // Task #2 aggregators.
  vcsheet,
  vcstack,
  failory,
  landscape_vc: landscapeVc,
  climatescape,
  mountside_ventures: mountsideVentures,
  founders_next_move: foundersNextMove,
  // Task #3.
  jvca,
  map_of_the_money: mapOfTheMoney,
  golden_egg_check: goldenEggCheck,
  wikipedia,
  generic_html: genericHtml,
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

  // Task #2: all airtable.com URLs route to the v2 importer (handles
  // shared views, shared bases, and Universe explore pages). The legacy
  // `airtable_share` importer remains in the registry for operator
  // override only.
  if (host === "airtable.com") return { name: "airtable", importer: airtable };
  if (host === "docs.google.com" && /\/spreadsheets\//.test(path)) return { name: "google_sheets", importer: googleSheets };
  if (host === "mercury.com") return { name: "mercury", importer: mercury };
  if (host === "openvc.app" || host === "api.openvc.app") return { name: "openvc", importer: openvc };
  if (host.endsWith("signal.nfx.com") || host.endsWith("nfx.com")) return { name: "nfx_signal", importer: nfxSignal };
  if (host === "folk.app" || host.endsWith(".folk.app")) {
    if (/^\/shared\//.test(path)) return { name: "folk", importer: folk };
    return { name: "folk_app", importer: folkApp };
  }
  if (host.includes("nycfounderguide") || host === "nycfounderguide.com") {
    return { name: "nyc_founder_guide", importer: nycFounderGuide };
  }
  if (host.includes("versatilevc")) return { name: "versatilevc", importer: versatileVc };

  // Task #2 — structured aggregator host routing.
  if (host === "vcsheet.com" || host.endsWith(".vcsheet.com")) return { name: "vcsheet", importer: vcsheet };
  if (host === "vcstack.io" || host === "vcstack.com" || host.endsWith(".vcstack.io") || host.endsWith(".vcstack.com")) {
    return { name: "vcstack", importer: vcstack };
  }
  if (host === "failory.com" || host.endsWith(".failory.com")) return { name: "failory", importer: failory };
  if (host === "landscape.vc" || host.endsWith(".landscape.vc")) return { name: "landscape_vc", importer: landscapeVc };
  if (host === "climatescape.org" || host.endsWith(".climatescape.org") || host === "climatescape.earth") {
    return { name: "climatescape", importer: climatescape };
  }
  if (host === "mountsideventures.com" || host.endsWith(".mountsideventures.com")) {
    return { name: "mountside_ventures", importer: mountsideVentures };
  }
  if (host === "foundersnextmove.com" || host.endsWith(".foundersnextmove.com")) {
    return { name: "founders_next_move", importer: foundersNextMove };
  }

  // Task #3 — regional / Wikipedia routing.
  if (host === "jvca.jp" || host.endsWith(".jvca.jp")) return { name: "jvca", importer: jvca };
  if (host === "mapofthemoney.com" || host.endsWith(".mapofthemoney.com")) {
    return { name: "map_of_the_money", importer: mapOfTheMoney };
  }
  if (host === "goldeneggcheck.com" || host.endsWith(".goldeneggcheck.com")) {
    return { name: "golden_egg_check", importer: goldenEggCheck };
  }
  if (host.endsWith("wikipedia.org")) return { name: "wikipedia", importer: wikipedia };

  if (/\.(csv|tsv)(\?|#|$)/.test(url)) return { name: "generic_csv_url", importer: genericCsvUrl };
  // Task #3: any URL we can't route to a site-specific importer falls
  // through to the AI-assisted generic HTML list importer rather than
  // generic_jsonld (which only fires when the page has ItemList LD+JSON).
  return { name: "generic_html", importer: genericHtml };
}

export type { FirmCandidate, FirmlistImportResult, FirmlistImporter } from "./types";
