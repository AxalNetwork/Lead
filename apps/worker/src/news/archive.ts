// Task #2: Wayback Machine save-page-now helper.
//
// We POST to https://web.archive.org/save/{url}. Wayback returns a 302
// to the immutable snapshot. We capture Location and persist it as
// news_items.archive_url. Best-effort — Wayback rate-limits aggressively
// so failure is non-fatal.

import type { Env } from "../types";

const SAVE_BASE = "https://web.archive.org/save/";
const TIMEOUT_MS = 15000;

export interface ArchiveResult {
  archive_url: string | null;
  archive_date: string | null;
  ok: boolean;
  status?: number;
  error?: string;
}

export async function archiveUrl(_env: Env, url: string): Promise<ArchiveResult> {
  if (!url || !/^https?:\/\//i.test(url)) return { archive_url: null, archive_date: null, ok: false, error: "bad_url" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SAVE_BASE}${url}`, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": "AIDataSignal/1.0 (+https://aidatasignal.com)",
        "accept": "text/html,application/xhtml+xml",
      },
      signal: ctrl.signal,
    });
    // Wayback responds 200 with a "Content-Location" header, or 302/3xx
    // with a Location header pointing to the snapshot.
    const loc = res.headers.get("content-location") || res.headers.get("location");
    if (loc) {
      const archive_url = loc.startsWith("http") ? loc : `https://web.archive.org${loc}`;
      return { archive_url, archive_date: new Date().toISOString(), ok: true, status: res.status };
    }
    // Some responses embed the snapshot URL inline. We don't parse HTML
    // here — the caller can retry later if Wayback was rate-limited.
    return { archive_url: null, archive_date: null, ok: false, status: res.status };
  } catch (e) {
    return { archive_url: null, archive_date: null, ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}
