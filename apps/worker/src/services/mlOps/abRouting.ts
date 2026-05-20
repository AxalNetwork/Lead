// Task #8: deterministic A/B routing for prompt versions.
//
// Given a prompt_key + entity_id (or any stable string) + a rollout
// percentage in [0,100], decide whether the request rides the new
// active prompt or the previous one. Hash is FNV-1a 32-bit (pure JS,
// no crypto.subtle) so it's identical in tests and Workers.

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Returns true when the request should be routed to the NEW active
 *  version. False = route to the previous version (fallback).
 *  - rolloutPct=100 → always true (full rollout)
 *  - rolloutPct=0   → always false (paused)
 *  - else: deterministic hash bucket. */
export function shouldRouteToNew(promptKey: string, salt: string, rolloutPct: number): boolean {
  if (rolloutPct >= 100) return true;
  if (rolloutPct <= 0) return false;
  const bucket = fnv1a32(`${promptKey}|${salt}`) % 100;
  return bucket < rolloutPct;
}
