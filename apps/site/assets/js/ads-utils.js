// Shared dashboard front-end utilities — single source of truth for HTML
// escaping, number formatting, and the authenticated fetch wrapper that were
// previously re-implemented (and diverging) across dashboard.js, dashboards.js,
// osint.js, and field-edit.js.
//
// Loaded NON-deferred in <head> (see _layouts/default.html) so window.adsUtil
// exists before any per-page body script or the deferred dashboard.js runs.
//
// NOTE: the API base URL is intentionally NOT centralized here — each consumer
// keeps resolving its own base (separate task). apiFetch takes a FULL url.
(function () {
  function escapeHtml(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmtInt(n) {
    if (n == null) return "—";
    return new Intl.NumberFormat("en-US").format(n);
  }
  function fmtPct(n) {
    if (n == null) return "—";
    return (Math.round(n * 1000) / 10) + "%";
  }
  function fmtUsd(n) {
    if (!n) return "—";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(0) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k";
    return "$" + n.toLocaleString();
  }
  // ---- CORS-simple request normaliser ------------------------------------
  // Cloudflare Access sits in front of the API host and answers a CORS
  // preflight (an OPTIONS request, which never carries the Access cookie)
  // with a 302 to the login page. The browser reports that as a failed
  // fetch, so anything that triggers a preflight breaks in production: a
  // JSON Content-Type, a custom header such as Idempotency-Key, or a
  // PUT/PATCH/DELETE method. `request()` rewrites a call so it is a CORS
  // "simple request" (no preflight):
  //   * drops `Content-Type: application/json` — the body is still the JSON
  //     string and the Worker parses it with c.req.json() regardless,
  //   * tunnels PUT/PATCH/DELETE as POST + `?_method=<VERB>`,
  //   * moves `Idempotency-Key` into `?_idempotency_key=`,
  //   * defaults credentials:"include" so the Access cookie rides along.
  // The Worker reverses the tunnel before routing
  // (apps/worker/src/middleware/simple_request.ts), so handlers still see the
  // real method and header. Every dashboard API call MUST go through
  // `adsUtil.request` / `adsUtil.apiFetch` rather than bare `fetch`.
  var SIMPLE_METHODS = { GET: 1, HEAD: 1, POST: 1 };
  var SIMPLE_CONTENT_TYPES = /^(text\/plain|multipart\/form-data|application\/x-www-form-urlencoded)\b/i;
  var SAFE_HEADERS = { accept: 1, "accept-language": 1, "content-language": 1, range: 1 };
  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof Headers !== "undefined" && h instanceof Headers) { h.forEach(function (v, k) { out[k] = v; }); return out; }
    if (Array.isArray(h)) { h.forEach(function (p) { out[p[0]] = p[1]; }); return out; }
    Object.keys(h).forEach(function (k) { if (h[k] != null) out[k] = h[k]; });
    return out;
  }
  function addParam(url, key, value) {
    var s = String(url);
    var hashIdx = s.indexOf("#");
    var hash = hashIdx >= 0 ? s.slice(hashIdx) : "";
    if (hashIdx >= 0) s = s.slice(0, hashIdx);
    return s + (s.indexOf("?") >= 0 ? "&" : "?") + encodeURIComponent(key) + "=" + encodeURIComponent(value) + hash;
  }
  // Pure: returns [url, init] for the simple-request form of (url, opts).
  function toSimpleRequest(url, opts) {
    var o = Object.assign({ credentials: "include" }, opts || {});
    var headers = headersToObject(o.headers);
    var kept = {};
    Object.keys(headers).forEach(function (k) {
      var lk = k.toLowerCase();
      var v = String(headers[k]);
      if (lk === "content-type") { if (SIMPLE_CONTENT_TYPES.test(v)) kept[k] = v; return; }
      if (lk === "idempotency-key") { url = addParam(url, "_idempotency_key", v); return; }
      if (SAFE_HEADERS[lk]) { kept[k] = v; return; }
      // Any other header forces a preflight and therefore a guaranteed
      // failure behind Access; drop it rather than ship a dead request.
      if (typeof console !== "undefined" && console.warn) console.warn("adsUtil.request: dropping non-simple header", k);
    });
    o.headers = kept;
    var method = String(o.method || "GET").toUpperCase();
    if (SIMPLE_METHODS[method]) {
      o.method = method;
    } else {
      url = addParam(url, "_method", method);
      o.method = "POST";
    }
    return [url, o];
  }
  // Drop-in replacement for window.fetch that returns the raw Response.
  function request(url, opts) {
    var r = toSimpleRequest(url, opts);
    return fetch(r[0], r[1]);
  }
  // Authenticated fetch over a FULL url. credentials:include so the Cloudflare
  // Access cookie rides along. Throws Error on !ok (using the response body's
  // `message` when present); returns parsed JSON or text.
  async function apiFetch(url, opts) {
    var res = await request(url, opts);
    if (!res.ok) {
      var msg = "HTTP " + res.status;
      try { var j = await res.json(); if (j && j.message) msg = j.message; } catch (e) {}
      var err = new Error(msg);
      err.status = res.status; // let callers special-case e.g. 401/403
      throw err;
    }
    var ct = res.headers.get("content-type") || "";
    return ct.indexOf("application/json") >= 0 ? res.json() : res.text();
  }
  window.adsUtil = {
    escapeHtml: escapeHtml,
    esc: escapeHtml,
    fmtInt: fmtInt,
    fmtPct: fmtPct,
    fmtUsd: fmtUsd,
    request: request,
    toSimpleRequest: toSimpleRequest,
    apiFetch: apiFetch,
  };
})();
