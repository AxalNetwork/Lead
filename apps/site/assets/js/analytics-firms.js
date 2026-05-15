// Firm analytics page (Task #20). All charts render dependency-free SVG
// using window.adsCharts where applicable.
(function () {
  if (!document.getElementById("ads-fa-funnel")) return;
  var API_BASE = (window.ADS && window.ADS.apiBase) || "https://api.aidatasignal.com";
  var charts = window.adsCharts || {};

  function api(path) {
    return fetch(API_BASE + path, { credentials: "include" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtMoney(n) { if (!n) return "$0"; if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k"; return "$" + n; }
  function setText(id, html) { var el = document.getElementById(id); if (el) { el.innerHTML = html; el.classList.remove("ads-empty"); } }
  function fail(id) { var el = document.getElementById(id); if (el) el.innerHTML = '<div class="ads-muted">Failed to load.</div>'; }

  function distributionSvg(buckets, fmt) {
    if (!buckets || !buckets.length) return '<div class="ads-empty">No data</div>';
    var W = 640, H = 160, PAD = 28;
    var max = Math.max.apply(null, buckets.map(function (b) { return b.count; }).concat([1]));
    var bw = (W - PAD * 2) / buckets.length;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">';
    svg += '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" stroke="#243066"/>';
    buckets.forEach(function (b, i) {
      var h = (b.count / max) * (H - PAD * 2);
      var x = PAD + i * bw, y = H - PAD - h;
      svg += '<rect x="' + (x + 1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="#5b8cff"><title>' + fmt(b.lo) + ' – ' + fmt(b.hi) + ': ' + b.count + '</title></rect>';
    });
    [0, Math.floor(buckets.length / 2), buckets.length - 1].forEach(function (i) {
      var x = PAD + i * bw + bw / 2;
      svg += '<text x="' + x.toFixed(1) + '" y="' + (H - PAD + 12) + '" fill="#8b94c2" font-size="10" text-anchor="middle">' + esc(fmt(buckets[i].lo)) + '</text>';
    });
    svg += '</svg>';
    return svg;
  }

  function loadFunnel() {
    api("/api/analytics/firms/funnel").then(function (data) {
      setText("ads-fa-funnel", charts.funnel ? charts.funnel(data.stages) : JSON.stringify(data));
    }).catch(function () { fail("ads-fa-funnel"); });
  }

  function loadTimeline() {
    api("/api/analytics/firms/timeline").then(function (data) {
      var pts = (data.points || []).map(function (p) { return { day: p.day, new_firms: p.new_firms }; });
      setText("ads-fa-timeline", charts.lineChart ? charts.lineChart(pts, { keys: ["new_firms"], colors: ["#23d6a4"] }) : JSON.stringify(data));
    }).catch(function () { fail("ads-fa-timeline"); });
  }

  function loadCheckDist() {
    var b = document.getElementById("ads-fa-check-buckets").value || "20";
    api("/api/analytics/firms/distribution?field=check_size_typical_usd&buckets=" + b).then(function (data) {
      setText("ads-fa-check-dist", distributionSvg(data.buckets, fmtMoney));
    }).catch(function () { fail("ads-fa-check-dist"); });
  }
  function loadAumDist() {
    api("/api/analytics/firms/distribution?field=aum_usd&buckets=20").then(function (data) {
      setText("ads-fa-aum-dist", distributionSvg(data.buckets, fmtMoney));
    }).catch(function () { fail("ads-fa-aum-dist"); });
  }

  function loadHeatmap() {
    api("/api/analytics/firms/heatmap").then(function (data) {
      var html = charts.heatmap ? charts.heatmap(data.stages || [], data.sectors || [], data.matrix || []) : "";
      setText("ads-fa-heatmap", html);
      // Attach drilldown clicks: each cell links to firms.html with stage+sector pre-applied.
      var cells = document.querySelectorAll("#ads-fa-heatmap tbody tr");
      cells.forEach(function (tr, ri) {
        var stage = (data.stages || [])[ri];
        tr.querySelectorAll("td").forEach(function (td, ci) {
          var sector = (data.sectors || [])[ci];
          if (!stage || !sector) return;
          td.style.cursor = "pointer";
          td.addEventListener("click", function () {
            window.location.href = "/dashboard/firms/?stages=" + encodeURIComponent(stage) + "&sectors=" + encodeURIComponent(sector);
          });
        });
      });
    }).catch(function () { fail("ads-fa-heatmap"); });
  }

  function loadGeo() {
    api("/api/analytics/firms/geo").then(function (data) {
      var items = (data.items || []).slice(0, 20).map(function (x) { return { label: x.country, value: x.count }; });
      setText("ads-fa-geo", charts.barChart ? charts.barChart(items, { color: "#5b8cff" }) : "");
    }).catch(function () { fail("ads-fa-geo"); });
  }

  function loadConnected() {
    api("/api/analytics/firms/connected?limit=20").then(function (data) {
      var items = (data.items || []).map(function (f) { return { label: f.name, value: f.total }; });
      setText("ads-fa-connected", charts.barChart ? charts.barChart(items, { color: "#a085ff" }) : "");
    }).catch(function () { fail("ads-fa-connected"); });
  }

  function loadSuccess() {
    var min = document.getElementById("ads-fa-success-min").value || "5";
    api("/api/analytics/firms/success-rate?min_portfolio=" + min).then(function (data) {
      var items = (data.items || []).slice(0, 15).map(function (f) {
        return { label: f.name + " (" + f.exits_count + "/" + f.portfolio_count + ")", value: Math.round(f.rate * 100) };
      });
      setText("ads-fa-success", charts.barChart ? charts.barChart(items, { color: "#23d6a4", format: function (v) { return v + "%"; } }) : "");
    }).catch(function () { fail("ads-fa-success"); });
  }

  function loadRoi() {
    api("/api/analytics/firms/sector-roi").then(function (data) {
      var items = (data.items || []).slice(0, 15).map(function (s) {
        return { label: s.sector + " — exit " + fmtMoney(s.avg_exit_usd) + " / check " + fmtMoney(s.avg_check_usd), value: s.roi };
      });
      setText("ads-fa-roi", charts.barChart ? charts.barChart(items, { color: "#ffb547", format: function (v) { return v.toFixed(1) + "x"; } }) : "");
    }).catch(function () { fail("ads-fa-roi"); });
  }

  function loadGaps() {
    api("/api/analytics/firms/coverage-gaps?limit=50").then(function (data) {
      var rows = (data.items || []).map(function (f) {
        return '<tr><td><a href="/dashboard/firm-detail/?id=' + f.id + '">' + esc(f.name) + '</a></td><td>' + esc(f.hq_country_iso2 || "") + '</td><td>' + (f.website ? '<a href="' + esc(f.website) + '" target="_blank" rel="noopener">' + esc(f.website.replace(/^https?:\/\//, "")) + '</a>' : "") + '</td></tr>';
      }).join("");
      setText("ads-fa-gaps", '<table class="ads-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Firm</th><th>Country</th><th>Website</th></tr></thead><tbody>' + (rows || '<tr><td colspan="3" class="ads-muted">No gaps.</td></tr>') + '</tbody></table>');
    }).catch(function () { fail("ads-fa-gaps"); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    loadFunnel(); loadTimeline(); loadCheckDist(); loadAumDist();
    loadHeatmap(); loadGeo(); loadConnected(); loadSuccess(); loadRoi(); loadGaps();
    document.getElementById("ads-fa-check-buckets").addEventListener("change", loadCheckDist);
    document.getElementById("ads-fa-success-min").addEventListener("change", loadSuccess);
  });
})();
