// signal.nfx.com is a gated source: profile data lives behind a login wall
// and cannot legally be scraped. The dispatcher rejects these URLs with a
// dedicated error code so the operator UI can surface a "use manual paste"
// hint instead of repeatedly retrying a doomed fetch.

export const NFX_ERROR = "gated_source_use_manual_paste";

export function isNfxProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)signal\.nfx\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}
