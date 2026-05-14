// Adds the v2 dashboard widgets (trend chart, scraper-health card, lead-quality
// card, funnel) to the home dashboard, when those mount points exist.
(function () {
  function api(path) {
    if (typeof window.adsApiFetch !== "function") return Promise.resolve(null);
    return window.adsApiFetch(path).catch(function () { return null; });
  }
  function set(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }

  async function load() {
    if (!window.adsCharts) return;
    var t = await api("/api/analytics/trends/leads?days=30");
    if (t && t.points) set("ads-home-trend", window.adsCharts.lineChart(t.points, { keys: ["new_leads", "verified"], height: 140 }));

    var h = await api("/api/analytics/scrapers/health");
    if (h) set("ads-home-health", window.adsCharts.sparkline(h.sparkline || {}));

    var q = await api("/api/analytics/leads/quality?days=30");
    if (q) {
      var ring = window.adsCharts.qualityRing(q.avg_score || 0, { size: 80 });
      set("ads-home-quality", '<div class="ads-q-row"><div>' + ring + '</div>' +
        '<div class="ads-q-legend"><div>Avg quality (30d)</div>' +
        '<div>Scored <b>' + (q.scored_leads || 0) + '</b> / ' + (q.total_leads || 0) + '</div></div></div>');
    }

    var f = await api("/api/analytics/leads/funnel");
    if (f && f.stages) set("ads-home-funnel", window.adsCharts.funnel(f.stages));
  }
  document.addEventListener("DOMContentLoaded", load);
})();
