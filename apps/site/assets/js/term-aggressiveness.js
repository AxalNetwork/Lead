// Task #18: Investor term-aggressiveness widget.
//
// Renders the weighted index + per-term means from
// GET /api/investors/:id/term-aggressiveness. ?id= comes from the URL
// per the Task #4 static-routing constraint.
(function () {
  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function bar(value) {
    var w = Math.max(0, Math.min(1, value || 0));
    var color = w > 0.6 ? "#c2410c" : w > 0.35 ? "#a16207" : "#16803d";
    return '<div style="background:#eee;border-radius:4px;height:8px;overflow:hidden;">' +
      '<div style="width:' + (w * 100).toFixed(1) + '%;height:8px;background:' + color + ';"></div></div>';
  }
  function render(data) {
    var body = $("ads-term-aggressiveness-body");
    if (!body) return;
    if (!data || !data.series_count) {
      body.innerHTML = '<p class="ads-muted">No preferred-stock attribution for this investor yet.</p>';
      return;
    }
    var summary = "<p><strong>Score:</strong> " + data.score.toFixed(2) +
      " · " + esc(String(data.series_count)) + " series" +
      " · " + esc(String(data.lead_count)) + " lead</p>";
    var termRows = Object.keys(data.per_term_means).map(function (k) {
      return "<tr><th>" + esc(k) + "</th><td style=\"min-width:160px;\">" + bar(data.per_term_means[k]) +
        '</td><td class="ads-muted">' + data.per_term_means[k].toFixed(2) + "</td></tr>";
    }).join("");
    var seriesRows = data.series.slice(0, 25).map(function (s) {
      return "<tr><td>" + esc(s.series_name) + "</td>" +
        '<td><a href="/dashboard/companies/detail/?id=' + encodeURIComponent(s.company_entity_id) + '">company</a></td>' +
        "<td>" + (s.is_lead ? "lead" : "follower") + "</td>" +
        "<td>" + s.score.toFixed(2) + "</td></tr>";
    }).join("");
    body.innerHTML = summary +
      "<h4>Per-term mean</h4>" +
      "<table class=\"ads-kv\"><tbody>" + termRows + "</tbody></table>" +
      "<h4 style=\"margin-top:1rem;\">Series (" + data.series.length + ")</h4>" +
      "<table class=\"ads-table\"><thead><tr><th>Series</th><th></th><th>Role</th><th>Score</th></tr></thead><tbody>" +
      seriesRows + "</tbody></table>";
  }
  function fail(msg) {
    var body = $("ads-term-aggressiveness-body");
    if (body) body.innerHTML = '<p class="ads-muted">' + msg + "</p>";
  }
  async function load() {
    var id = new URLSearchParams(window.location.search).get("id");
    if (!id) { fail("Open an investor page to view term aggressiveness."); return; }
    try {
      var apiBase = (window.ADS && window.ADS.API_BASE) || "https://api.aidatasignal.com";
      var res = await fetch(apiBase + "/api/investors/" + encodeURIComponent(id) + "/term-aggressiveness", { credentials: "include" });
      if (res.status === 403) { fail("Sign in to view term aggressiveness."); return; }
      if (!res.ok) { fail("Failed to load (HTTP " + res.status + ")."); return; }
      var data = await res.json();
      render(data);
    } catch (e) {
      fail("Failed to load: " + (e && e.message ? e.message : "network error"));
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();
})();
