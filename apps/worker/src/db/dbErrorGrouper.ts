// Task #7: pure helpers for the deduped DB-error panel on
// /dashboard/ops-crawler/. The grouper turns raw `error_log` rows
// (code='db_error') into (normalized_message, route, count) tuples
// the operator can act on, instead of an opaque "223 db errors"
// counter.
//
// Pure module: no DB, no env, no I/O — easy to unit test. The route
// handler in `routes/ops_crawler.ts` does the safeQuery wrap and the
// 7-day filter; we just normalize + group what it hands us.

export interface RawDbErrorRow {
  message: string | null;
  cause_message?: string | null;
  url?: string | null;
  method?: string | null;
}

export interface GroupedDbError {
  normalized_message: string;
  route: string;
  count: number;
  example_message: string;
  example_url: string | null;
}

/**
 * Normalize a SQLite/D1 error string into a stable cluster key.
 *
 * Strategy:
 *  - Lowercase
 *  - Collapse runs of whitespace
 *  - Strip noise that varies between calls but doesn't change the
 *    underlying bug: numeric ids, hex/uuids, quoted literals,
 *    bind-parameter values in the trailing `parameters:` section
 *    that D1 sometimes appends.
 *  - Keep the SQLite error TOKEN (`no such table`, `no such column`,
 *    `unique constraint failed`, `database is locked`, …) and the
 *    identifier that follows it so two different missing tables
 *    cluster separately.
 */
export function normalizeDbErrorMessage(raw: string | null | undefined): string {
  if (!raw) return "(empty)";
  let s = String(raw).toLowerCase();

  // D1 sometimes appends a "parameters: [...]" / "near \"...\":" tail
  // that varies per call but doesn't change the cluster.
  s = s.replace(/\s*parameters?:\s*\[.*$/s, "");
  s = s.replace(/\s*at offset \d+/g, "");

  // Strip quoted string literals (single + double + backtick).
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "'…'");
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '"…"');
  s = s.replace(/`(?:[^`\\]|\\.)*`/g, "`…`");

  // Strip uuid-shaped ids.
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>");
  // Strip hex blobs / long hex ids.
  s = s.replace(/\b[0-9a-f]{16,}\b/g, "<hex>");
  // Strip integers (keep small whitespace for readability).
  s = s.replace(/\b\d{2,}\b/g, "<n>");

  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();

  // Cap length so a runaway message can't blow up the response.
  if (s.length > 400) s = s.slice(0, 400) + "…";
  return s || "(empty)";
}

/**
 * Extract the route key from an error_log row's `url` column. The
 * panel groups by route, not full URL, so two failing calls to
 * `/api/persons/<a>/verify` and `/api/persons/<b>/verify` cluster
 * together. Falls back to `"(unknown)"` when the url is missing or
 * unparseable.
 */
export function routeFromUrl(url: string | null | undefined): string {
  if (!url) return "(unknown)";
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // url may be a bare path (when the logger wrote a Hono request
    // path rather than a full URL).
    pathname = String(url).split("?")[0] || "(unknown)";
  }
  if (!pathname) return "(unknown)";
  // Replace path segments that look like ids with `:id` so per-record
  // routes collapse into one cluster.
  const parts = pathname.split("/").map((seg) => {
    if (!seg) return seg;
    if (/^[0-9]+$/.test(seg)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ":id";
    if (seg.length >= 12 && /[0-9]/.test(seg) && /[a-z]/i.test(seg)) return ":id";
    return seg;
  });
  return parts.join("/") || "(unknown)";
}

/**
 * Group raw rows by (normalized_message, route) and sort descending
 * by count. Preserves one example_message / example_url per group
 * so the operator can drill into a real case from the UI.
 */
export function groupDbErrors(rows: readonly RawDbErrorRow[]): GroupedDbError[] {
  const acc = new Map<string, GroupedDbError>();
  for (const row of rows) {
    // Prefer cause_message (the SQLite text) over the wrapper message
    // ("db_error") so clustering is meaningful.
    const raw = (row.cause_message ?? row.message ?? "") as string;
    const normalized_message = normalizeDbErrorMessage(raw);
    const route = routeFromUrl(row.url ?? null);
    const key = normalized_message + "\u0001" + route;
    const existing = acc.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      acc.set(key, {
        normalized_message,
        route,
        count: 1,
        example_message: (raw || "").slice(0, 600),
        example_url: row.url ?? null,
      });
    }
  }
  return Array.from(acc.values()).sort((a, b) => b.count - a.count);
}
