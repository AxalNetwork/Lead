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
  // Authenticated fetch over a FULL url. credentials:include so the Cloudflare
  // Access cookie rides along. Throws Error on !ok (using the response body's
  // `message` when present); returns parsed JSON or text.
  async function apiFetch(url, opts) {
    var res = await fetch(url, Object.assign({ credentials: "include" }, opts || {}));
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
    apiFetch: apiFetch,
  };
})();
