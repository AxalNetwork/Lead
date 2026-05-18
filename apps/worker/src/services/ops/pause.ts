// Task #2: shared pause-flag accessor. The operator console writes
// these KV keys via POST /api/ops/crawler/pause; the crawler runtime
// (frontier drain, per-type fetch path, hourly seed sweep) reads them
// to short-circuit work. Keep this module dependency-free — it is on
// the hot path of every fetch.

import type { Env } from "../../types";

const KEY_GLOBAL = "ops:crawler:paused";
const keyHost = (host: string) => `ops:crawler:paused:host:${host.toLowerCase()}`;
const keyType = (typeId: string) => `ops:crawler:paused:type:${typeId}`;

/** True if the operator has paused all crawler activity. */
export async function isGlobalPaused(env: Env): Promise<boolean> {
  try { return (await env.SESSIONS.get(KEY_GLOBAL)) === "1"; }
  catch { return false; }
}

/** True if `host` is paused. Empty/invalid input → false. */
export async function isHostPaused(env: Env, host: string | null | undefined): Promise<boolean> {
  if (!host) return false;
  try { return (await env.SESSIONS.get(keyHost(host))) === "1"; }
  catch { return false; }
}

/** True if `profile_type_id` is paused. */
export async function isProfileTypePaused(env: Env, typeId: string | null | undefined): Promise<boolean> {
  if (!typeId) return false;
  try { return (await env.SESSIONS.get(keyType(typeId))) === "1"; }
  catch { return false; }
}

/**
 * Combined check for a unit of crawl work. Returns the scope that is
 * paused (for logging / audit) or null if work may proceed.
 */
export async function pauseScopeFor(
  env: Env,
  args: { host?: string | null; profileTypeId?: string | null },
): Promise<"all" | "host" | "profile_type" | null> {
  if (await isGlobalPaused(env)) return "all";
  if (args.host && await isHostPaused(env, args.host)) return "host";
  if (args.profileTypeId && await isProfileTypePaused(env, args.profileTypeId)) return "profile_type";
  return null;
}
