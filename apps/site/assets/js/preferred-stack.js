// Task #18: Preferred-stock panel client.
//
// Renders the per-series cards + percentile pills from
// GET /api/companies/:id/preferred-stack. ?id= comes from the URL per
// the Task #4 static-routing constraint (Jekyll on GitHub Pages can't
// bind a dynamic /:id path segment).
(function () {
  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function safeUrl(u) {
    // Only allow http(s) — prevents javascript:/data:/vbscript: hrefs.
    if (!u) return null;
    try {
      var parsed = new URL(u, window.location.origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed.href;
    } catch (e) { return null; }
  }
  function fmtNum(n, opts) {
    if (n == null) return "—";
    if (opts && opts.pct) return (n * 100).toFixed(1) + "%";
    if (opts && opts.usd) {
      if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
      return "$" + n.toLocaleString();
    }
    return String(n);
  }
  function flagLabel(f) {
    return ({ gt_1x_lp: ">1× LP", uncapped_participating: "Uncapped participating", full_ratchet: "Full ratchet" })[f] || f;
  }
  function renderSeries(s) {
    var flags = (s.aggressive_flags || []).map(function (f) {
      return '<span class="ads-pill ads-pill-warn">' + esc(flagLabel(f)) + "</span>";
    }).join(" ");
    var pct = s.percentiles || {};
    var bucket = s.bucket;
    var bucketLine = bucket
      ? '<div class="ads-muted">Bucket: ' + esc(bucket.stage) + " · " + esc(bucket.sector) + " · " + esc(String(bucket.year)) +
        " · n=" + esc(String(bucket.sample_size)) + (bucket.low_sample ? " (low sample)" : "") + "</div>"
      : "";
    var part = s.participating === 1 ? (s.participating_cap_x != null ? "Yes, capped @ " + s.participating_cap_x + "×" : "Yes, uncapped")
             : s.participating === 0 ? "No" : "—";
    var rows = [
      ["Original issue price", fmtNum(s.original_issue_price_usd, { usd: true })],
      ["Liquidation preference", s.liquidation_pref_x != null ? s.liquidation_pref_x + "×" : "—"],
      ["Participating", part],
      ["Anti-dilution", esc(s.anti_dilution || "—")],
      ["Dividend rate", fmtNum(s.dividend_rate_pct, { pct: true })],
      ["Board (total / investor / founder / indep.)",
        [s.board_total, s.board_investor_seats, s.board_founder_seats, s.board_independent_seats]
          .map(function (x) { return x == null ? "—" : x; }).join(" / ")],
      ["Closing date", esc(s.closing_date || "—")],
      ["Source", esc(s.source || "—") + (safeUrl(s.source_url) ? ' · <a href="' + esc(safeUrl(s.source_url)) + '" target="_blank" rel="noopener">view</a>' : "")],
    ].map(function (kv) {
      return "<tr><th>" + esc(kv[0]) + "</th><td>" + kv[1] + "</td></tr>";
    }).join("");
    var pctLines = [];
    if (pct.lp_x_vs_median != null) pctLines.push("LP " + pct.lp_x_vs_median + "× of bucket median");
    if (pct.pct_lp_gt_1x_in_bucket != null) pctLines.push(fmtNum(pct.pct_lp_gt_1x_in_bucket, { pct: true }) + " of bucket are >1× LP");
    if (pct.pct_participating_in_bucket != null) pctLines.push(fmtNum(pct.pct_participating_in_bucket, { pct: true }) + " of bucket participating");
    if (pct.pct_full_ratchet_in_bucket != null) pctLines.push(fmtNum(pct.pct_full_ratchet_in_bucket, { pct: true }) + " of bucket full-ratchet");
    var pctBlock = pctLines.length ? '<div class="ads-muted" style="margin-top:.5rem;">' + pctLines.map(esc).join(" · ") + "</div>" : "";
    return '<div class="ads-card" style="margin-bottom:1rem;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<h4 style="margin:0;">' + esc(s.series_name) + "</h4>" +
        "<div>" + flags + "</div>" +
      "</div>" +
      bucketLine +
      '<table class="ads-kv" style="margin-top:.5rem;"><tbody>' + rows + "</tbody></table>" +
      pctBlock +
      "</div>";
  }
  function render(data) {
    var body = $("ads-preferred-stack-body");
    if (!body) return;
    if (!data || !data.series || !data.series.length) {
      body.innerHTML = '<p class="ads-muted">No preferred-stock series extracted for this company yet.</p>';
      return;
    }
    body.innerHTML = data.series.map(renderSeries).join("");
  }
  function fail(msg) {
    var body = $("ads-preferred-stack-body");
    if (body) body.innerHTML = '<p class="ads-muted">' + msg + "</p>";
  }
  async function load() {
    var id = new URLSearchParams(window.location.search).get("id");
    if (!id) { fail("Open a company page to view preferred stack."); return; }
    try {
      var apiBase = (window.ADS && window.ADS.API_BASE);
      var res = await fetch(apiBase + "/api/companies/" + encodeURIComponent(id) + "/preferred-stack", { credentials: "include" });
      if (res.status === 403) { fail("Sign in to view preferred stack."); return; }
      if (!res.ok) { fail("Failed to load (HTTP " + res.status + ")."); return; }
      var data = await res.json();
      render(data);
    } catch (e) {
      fail("Failed to load: " + (e && e.message ? e.message : "network error"));
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();
})();
