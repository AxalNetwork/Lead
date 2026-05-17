// Timezone-aware digest scheduling.
//
// `next 9 a.m. local` in a user's IANA timezone, returned as a UTC ISO
// string. JS Date has no native IANA support; we compute the wall-clock
// instant in the target zone via Intl.DateTimeFormat and reverse the
// offset to convert back to UTC.

import type { Env } from "../types";

export interface UserDigestPrefs {
  email: string;
  timezone: string;
  digest_hour: number;
  digest_weekday: number; // 1=Mon .. 7=Sun
}

export async function loadDigestPrefs(env: Env, email: string): Promise<UserDigestPrefs> {
  try {
    const r = await env.DB.prepare(
      `SELECT email, timezone, digest_hour, digest_weekday FROM user_prefs WHERE email = ?`,
    ).bind(email).first<UserDigestPrefs>();
    if (r) return r;
  } catch { /* table missing — fall through */ }
  return { email, timezone: "UTC", digest_hour: 9, digest_weekday: 1 };
}

/**
 * Compute the next scheduled UTC instant for the given digest frequency
 * in the user's local timezone.
 *  - hourly: top of next hour (UTC; the spec doesn't tz-shift hourly).
 *  - daily:  next `digest_hour` local time.
 *  - weekly: next `digest_weekday` at `digest_hour` local time.
 */
export function computeDigestScheduledFor(freq: string, prefs: UserDigestPrefs, now: Date = new Date()): string {
  if (freq === "hourly") {
    const next = new Date(now);
    next.setUTCMinutes(0, 0, 0); next.setUTCHours(now.getUTCHours() + 1);
    return next.toISOString();
  }
  const tz = prefs.timezone || "UTC";
  const targetHour = clampHour(prefs.digest_hour);
  if (freq === "weekly") {
    const targetDow = clampDow(prefs.digest_weekday);
    return nextLocalAt(now, tz, targetHour, targetDow);
  }
  // daily (default)
  return nextLocalAt(now, tz, targetHour, null);
}

function clampHour(h: unknown): number {
  const n = Math.floor(Number(h));
  if (!Number.isFinite(n)) return 9;
  return Math.max(0, Math.min(23, n));
}

function clampDow(d: unknown): number {
  const n = Math.floor(Number(d));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(7, n));
}

/**
 * Find the next UTC instant that, when projected into `tz`, is at
 * `hourLocal`:00:00, optionally restricted to a specific ISO weekday
 * (1=Mon..7=Sun). Linear scan day-by-day from "today" — cheap and avoids
 * DST edge math.
 */
function nextLocalAt(now: Date, tz: string, hourLocal: number, dowLocal: number | null): string {
  // Walk up to 14 candidate days. Stops as soon as we find a future instant
  // that matches both constraints.
  for (let offset = 0; offset < 14; offset++) {
    const candidate = utcInstantForLocalWallClock(now, tz, offset, hourLocal);
    if (!candidate) continue;
    if (candidate.getTime() <= now.getTime()) continue;
    if (dowLocal !== null) {
      const isoDow = isoWeekdayInTz(candidate, tz);
      if (isoDow !== dowLocal) continue;
    }
    return candidate.toISOString();
  }
  // Fallback (should be unreachable): 24h from now.
  return new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
}

/**
 * Given a base `now` and a `dayOffset`, return the UTC Date whose local
 * representation in `tz` is "today + offset days, hourLocal:00:00".
 */
function utcInstantForLocalWallClock(now: Date, tz: string, dayOffset: number, hourLocal: number): Date | null {
  const parts = getLocalParts(now, tz);
  if (!parts) return null;
  // Build a tentative UTC instant for the wall clock, then correct for the
  // tz offset at that instant.
  const tentative = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, hourLocal, 0, 0);
  const offsetMin = tzOffsetMinutes(new Date(tentative), tz);
  return new Date(tentative - offsetMin * 60 * 1000);
}

function getLocalParts(d: Date, tz: string): { year: number; month: number; day: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
  } catch { return null; }
}

/** Minutes east of UTC at the given instant. */
function tzOffsetMinutes(d: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = fmt.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return Math.round((asUtc - d.getTime()) / 60000);
  } catch { return 0; }
}

function isoWeekdayInTz(d: Date, tz: string): number {
  try {
    const dayShort = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
    return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[dayShort as "Mon"] ?? 1);
  } catch { return 1; }
}
