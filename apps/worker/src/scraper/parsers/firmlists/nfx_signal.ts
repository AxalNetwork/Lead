import type { Env } from "../../../types";
import type { FirmlistImportResult } from "./types";

/**
 * NFX Signal importer — DELIBERATELY DISABLED.
 *
 * Signal.nfx.com is login-gated. Scraping it would require an authenticated
 * session and would violate their ToS. Operators who want to ingest data
 * from Signal must paste the rows manually into
 *   POST /api/import/nfx/paste   (body: [{name, url, ...}])
 * which routes through the normal upsert path.
 */
export async function importFirms(url: string, _env: Env): Promise<FirmlistImportResult> {
  return {
    firms: [],
    totalSeen: 0,
    errors: [
      "nfx_signal_login_gated:scraping_disabled",
      `use_paste_endpoint:POST /api/import/nfx/paste (source: ${url})`,
    ],
  };
}
