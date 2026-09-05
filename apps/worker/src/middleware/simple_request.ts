// CORS-simple request tunnel (dashboard ⇄ Worker).
//
// Cloudflare Access fronts api.aidatasignal.com and answers a CORS
// preflight (an OPTIONS request, which never carries the Access cookie)
// with a 302 to the login page. The browser treats that as a failed
// preflight, so every dashboard call that triggers one — a JSON
// Content-Type, a custom header such as Idempotency-Key, or a
// PUT/PATCH/DELETE method — fails before it reaches this Worker.
//
// The dashboard therefore sends every write as a CORS "simple request"
// (see apps/site/assets/js/ads-utils.js → adsUtil.request): a POST with
// no custom headers, tunnelling the real verb in `?_method=` and the
// idempotency key in `?_idempotency_key=`. This function reverses that
// rewrite BEFORE Hono routes the request, so route handlers keep seeing
// the true method and header exactly as if the preflight had succeeded.
//
// Only POST is ever unwrapped, and only to PUT/PATCH/DELETE: a GET can
// never be upgraded to a write, and an unknown `_method` value is left
// untouched so the router 404s/405s it as usual.

export const METHOD_OVERRIDE_PARAM = "_method";
export const IDEMPOTENCY_KEY_PARAM = "_idempotency_key";

const OVERRIDABLE_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

export function unwrapSimpleRequest(req: Request): Request {
  if (req.method !== "POST") return req;
  const url = new URL(req.url);
  const rawMethod = url.searchParams.get(METHOD_OVERRIDE_PARAM);
  const idem = url.searchParams.get(IDEMPOTENCY_KEY_PARAM);
  if (rawMethod == null && idem == null) return req;

  const method = rawMethod == null ? "POST" : rawMethod.toUpperCase();
  if (rawMethod != null && !OVERRIDABLE_METHODS.has(method)) return req;

  url.searchParams.delete(METHOD_OVERRIDE_PARAM);
  url.searchParams.delete(IDEMPOTENCY_KEY_PARAM);

  const headers = new Headers(req.headers);
  if (idem && !headers.has("Idempotency-Key")) headers.set("Idempotency-Key", idem);

  // `new Request(url, req)` clones method/headers/body from the original;
  // the second construction swaps the verb while inheriting that body.
  const relocated = new Request(url.toString(), req);
  return new Request(relocated, { method, headers });
}
