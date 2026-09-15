// Cross-site write protection.
//
// `accessGuard` accepts the `CF_Authorization` cookie on its own (see
// middleware/access.ts). An ambient cookie is therefore sufficient to
// authenticate a write, which is the exact shape CSRF exploits: a page on
// another origin causes the victim's browser to issue the request, and the
// browser attaches the cookie without the attacker ever seeing it.
//
// CORS does not prevent this. It governs whether the attacker can READ the
// response, not whether the write executes. And the preflight that would
// block a JSON request never fires for a "simple request" — a form POST with
// `application/x-www-form-urlencoded`. 84 of this API's mutating handlers
// parse no request body at all; they act on the path alone, so a simple
// form POST reaches them intact. Among them `POST /api/ops/garbage/:id/purge`,
// which permanently deletes an entity and cascades across facts, rel_edges,
// channels, entity_roles, entity_history and entity_legacy_map.
//
// Whether a browser actually attaches `CF_Authorization` cross-site depends
// on that cookie's SameSite attribute, which is Cloudflare Access
// configuration and not visible from this repository. This guard is worth
// having either way precisely because it does not depend on a setting we
// cannot see from here.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/**
 * Origins allowed to make authenticated cross-origin requests.
 *
 * Exported and shared with the `cors()` configuration in index.ts on purpose.
 * Two copies of this list is the one realistic way for this guard to lock the
 * dashboard out of its own API: CORS would permit an origin that the guard
 * then rejects, and every write would 403 until someone reverted it.
 */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  "https://aidatasignal.com",
  "https://www.aidatasignal.com",
  // README/Replit deployment target for the dashboard (DNS pending).
  "https://app.aidatasignal.com",
]);

/** Methods that cannot change state, so cannot be a CSRF target. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `Sec-Fetch-Site` values that mean the request came from somewhere else.
 *
 * `same-site` is deliberately NOT here: the dashboard is served from
 * aidatasignal.com and calls api.aidatasignal.com, which is cross-ORIGIN but
 * same-SITE. Rejecting it would block every write the dashboard makes.
 */
const FOREIGN_FETCH_SITES = new Set(["cross-site", "cross-origin"]);

/**
 * Reject a mutating request only on positive evidence that it came from
 * another site.
 *
 * The ordering matters:
 *
 *   1. Safe methods are never blocked. There are no state-changing GET
 *      handlers in this worker (verified), so reads need no protection and
 *      blocking them would only break the dashboard.
 *   2. An `Origin` we recognise passes; one we do not is refused. Browsers
 *      always send `Origin` on cross-origin requests and on same-origin
 *      non-GET requests, so this is the main path.
 *   3. Failing that, `Sec-Fetch-Site` — sent by every current browser — is
 *      consulted so a same-origin request that omitted `Origin` is still
 *      judged on real evidence.
 *   4. Neither header present means the caller is not a browser, and is
 *      allowed.
 *
 * Step 4 is load-bearing rather than a loophole. Non-browser callers
 * (scripts/provision-cf.mjs, the deploy workflow, external compute runners)
 * send neither header, and a client that has to supply its own credential is
 * not the threat this guards against — CSRF is about a credential the browser
 * attaches on the attacker's behalf. Refusing requests for an ABSENT header
 * would break those callers and buy nothing: an attacker who can set headers
 * can set `Origin` too.
 */
export const crossSiteGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) return next();

  const origin = c.req.header("Origin");
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return c.json({ error: "cross_site_write_blocked", origin }, 403);
    }
    return next();
  }

  const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
  if (fetchSite && FOREIGN_FETCH_SITES.has(fetchSite)) {
    return c.json({ error: "cross_site_write_blocked", sec_fetch_site: fetchSite }, 403);
  }

  return next();
};
