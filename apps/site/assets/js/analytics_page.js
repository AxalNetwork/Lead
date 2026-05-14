// Wires the /dashboard/analytics/ page to the worker /api/analytics/* endpoints.
// Reuses adsApiFetch and adsCharts from dashboard.js + charts.js.
(function () {
  function api(path) {
    if (typeof window.adsApiFetch !== "function") return Promise.resolve(null);
    return window.adsApiFetch(path).catch(function (e) { console.warn("analytics api fail", path, e); return null; });
  }
  function set(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
  function fmtUsd(v) { return "$" + (Math.round((v || 0) * 100) / 100).toFixed(2); }
  function fmtBigUsd(v) {
    v = v || 0;
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
    return "$" + v;
  }

  async function load() {
    if (!window.adsCharts) return;

    var trend = await api("/api/analytics/trends/leads?days=30");
    if (trend && trend.points) set("ads-chart-trend", window.adsCharts.lineChart(trend.points, { keys: ["new_leads", "verified"] }));
    else set("ads-chart-trend", '<div class="ads-empty">No trend data</div>');

    var q = await api("/api/analytics/leads/quality?days=30");
    if (q) {
      var ringHtml = window.adsCharts.qualityRing(q.avg_score || 0, { size: 110 });
      var legend = '<div class="ads-q-legend">' +
        '<div>Total leads <b>' + (q.total_leads || 0) + '</b></div>' +
        '<div>Scored (30d) <b>' + (q.scored_leads || 0) + '</b></div>' +
        (q.avg_breakdown ? Object.keys(q.avg_breakdown).map(function (k) {
          return '<div>' + k + ' <b>' + Math.round(q.avg_breakdown[k] * 100) + '%</b></div>';
        }).join("") : "") +
        '</div>';
      var bucketBars = window.adsCharts.barChart([
        { label: "0–25", value: q.buckets.p0_25 },
        { label: "25–50", value: q.buckets.p25_50 },
        { label: "50–75", value: q.buckets.p50_75 },
        { label: "75–100", value: q.buckets.p75_100 },
      ], { color: "#5b8cff" });
      set("ads-chart-quality", '<div class="ads-q-row"><div>' + ringHtml + '</div>' + legend + '</div>' + bucketBars);
    } else { set("ads-chart-quality", '<div class="ads-empty">No quality data</div>'); }

    var f = await api("/api/analytics/leads/funnel");
    if (f && f.stages) set("ads-chart-funnel", window.adsCharts.funnel(f.stages));
    else set("ads-chart-funnel", '<div class="ads-empty">No funnel data</div>');

    var h = await api("/api/analytics/scrapers/health");
    if (h) {
      var spark = window.adsCharts.sparkline(h.sparkline || {});
      var rows = (h.hosts || []).slice(0, 8).map(function (r) {
        return '<tr><td>' + r.host + '</td><td>' + r.attempts + '</td><td>' + Math.round(r.block_rate * 100) + '%</td><td>' + r.avg_ms + 'ms</td><td>' + fmtUsd(r.cost_usd) + '</td></tr>';
      }).join("");
      set("ads-chart-health",
        '<div style="margin-bottom:10px">' + spark + '<div class="ads-muted" style="font-size:11px">Hourly tier mix · last 24h</div></div>' +
        '<table class="ads-table"><thead><tr><th>Host</th><th>Attempts</th><th>Block</th><th>Avg</th><th>Cost</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }

    var cost = await api("/api/analytics/scrapers/cost?days=30");
    if (cost) {
      var bars = (cost.providers || []).slice(0, 10).map(function (p) {
        return { label: p.provider, value: p.cost_usd || 0 };
      });
      set("ads-chart-cpv", window.adsCharts.barChart(bars, { format: fmtUsd, color: "#ffb547" }));
    }

    // Per-source ROI: leads found in window.
    var src = await api("/api/analytics/sources");
    if (src && src.items) {
      set("ads-chart-roi", window.adsCharts.barChart(src.items.map(function (s) {
        return { label: s.domain, value: s.lead_count };
      }), { color: "#23d6a4" }));
    }

    var seg = await api("/api/analytics/leads/segments");
    if (seg) set("ads-chart-segments", window.adsCharts.heatmap(seg.countries || [], seg.sectors || [], seg.matrix || []));

    var v = await api("/api/analytics/leads/value");
    if (v) {
      var html = '<div class="ads-kpi__value" style="margin-bottom:14px">' + fmtBigUsd(v.total_value_usd) + '</div>';
      html += window.adsCharts.barChart((v.by_status || []).map(function (r) {
        return { label: r.status, value: r.value_usd };
      }), { format: fmtBigUsd, color: "#5b8cff" });
      set("ads-chart-value", html);
    }

    var jp = await api("/api/analytics/jobs/perf?days=30");
    if (jp && jp.points) {
      set("ads-chart-jobs", window.adsCharts.lineChart(jp.points, {
        keys: ["completed", "failed"], colors: ["#23d6a4", "#ff5d6c"],
      }) + '<div class="ads-muted" style="margin-top:8px;font-size:12px">Avg completed: ' +
        (jp.avg_completed_seconds == null ? "—" : (jp.avg_completed_seconds + "s")) + ' · ' + (jp.completed_jobs || 0) + ' jobs</div>');
    }
  }

  document.addEventListener("DOMContentLoaded", load);
})();
