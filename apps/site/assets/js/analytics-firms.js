// Firm analytics page (Task #20). All charts render dependency-free SVG
// using window.adsCharts where applicable.
(function () {
  if (!document.getElementById("ads-fa-funnel")) return;
  var API_BASE = (window.ADS && window.ADS.apiBase);
  var charts = window.adsCharts || {};

  // ---- Static cartogram of country tiles. Each cell is one country at a
  // hand-picked (col,row) on a 22x12 grid. This is a pragmatic alternative to
  // shipping a 100KB topojson — gives an at-a-glance world map without any
  // runtime dependency. Coordinates roughly mirror geographic position.
  var COUNTRY_TILES = {
    US: [4, 4], CA: [4, 2], MX: [4, 6], BR: [7, 8], AR: [6, 10], CL: [5, 10],
    CO: [6, 7], PE: [6, 8], VE: [7, 7],
    GB: [10, 3], IE: [9, 3], FR: [10, 4], ES: [10, 5], PT: [9, 5], DE: [11, 3],
    NL: [10, 3], BE: [10, 4], CH: [11, 4], IT: [11, 5], AT: [11, 4], SE: [11, 2],
    NO: [10, 2], FI: [12, 2], DK: [11, 3], PL: [12, 3], CZ: [11, 4], RO: [12, 4],
    GR: [12, 5], TR: [13, 5], UA: [13, 3], RU: [15, 2],
    IL: [13, 6], AE: [14, 6], SA: [14, 7], EG: [13, 6], ZA: [12, 10], NG: [11, 8],
    KE: [13, 8], MA: [10, 6],
    IN: [16, 6], PK: [15, 6], BD: [17, 6], LK: [16, 8],
    CN: [18, 5], JP: [20, 5], KR: [19, 5], TW: [19, 6], HK: [19, 6],
    SG: [18, 8], MY: [18, 7], ID: [19, 8], TH: [18, 7], VN: [19, 7], PH: [20, 7],
    AU: [20, 10], NZ: [21, 11],
  };

  function api(path) {
    return window.adsUtil.request(API_BASE + path, { credentials: "include" }).then(function (r) {
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

  // World cartogram. `data` is an array of { country: 'US', count: 42 }.
  // Each tile colored on a quintile scale; clicking a tile drills to firms.html
  // pre-filtered by HQ country. Unmapped countries fall back to a list below.
  function worldMap(data) {
    var byIso = {};
    var unknownCount = 0, total = 0;
    (data || []).forEach(function (r) {
      var n = r.count || 0;
      total += n;
      var iso = String(r.country == null ? "" : r.country).toUpperCase();
      // The geo endpoint buckets country-less firms as "__unknown__"; keep
      // that out of the color scale and surface it explicitly below.
      if (!iso || iso === "__UNKNOWN__") { unknownCount += n; return; }
      byIso[iso] = n;
    });
    // Build DISTINCT bucket thresholds so the legend never shows repeated or
    // all-zero cutoffs. With few distinct values we collapse to that many
    // buckets (one per value) instead of forcing five degenerate quintiles.
    var sorted = Object.keys(byIso).map(function (k) { return byIso[k]; })
      .filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
    var uniq = [];
    sorted.forEach(function (n) { if (uniq[uniq.length - 1] !== n) uniq.push(n); });
    var PAL = ["#dbe7ff", "#a9c3ff", "#7aa0ff", "#5179ee", "#2a4fbf"];
    var thresholds = [];
    if (uniq.length) {
      var nb = Math.min(PAL.length, uniq.length);
      for (var i = 0; i < nb; i++) {
        var t = uniq[Math.floor((uniq.length - 1) * (i + 1) / nb)];
        if (thresholds[thresholds.length - 1] !== t) thresholds.push(t);
      }
    }
    var NB = thresholds.length;
    function bucketColor(idx) {
      if (NB <= 1) return PAL[3];
      return PAL[Math.round(idx * (PAL.length - 1) / (NB - 1))];
    }
    function color(n) {
      if (!n) return "#e8ecf6";
      for (var i = 0; i < NB; i++) if (n <= thresholds[i]) return bucketColor(i);
      return bucketColor(NB - 1);
    }
    var COLS = 22, ROWS = 12, CELL = 22, PAD = 8;
    var W = COLS * CELL + PAD * 2, H = ROWS * CELL + PAD * 2 + 28;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;font-family:inherit">';
    Object.keys(COUNTRY_TILES).forEach(function (iso) {
      var p = COUNTRY_TILES[iso];
      var x = PAD + p[0] * CELL, y = PAD + p[1] * CELL;
      var n = byIso[iso] || 0;
      svg += '<a href="/dashboard/firms/?country=' + iso.toLowerCase() + '">';
      svg += '<rect x="' + x + '" y="' + y + '" width="' + (CELL - 2) + '" height="' + (CELL - 2) + '" rx="2" ry="2" fill="' + color(n) + '" stroke="#fff"><title>' + iso + ': ' + n + '</title></rect>';
      svg += '<text x="' + (x + (CELL - 2) / 2) + '" y="' + (y + (CELL - 2) / 2 + 3) + '" font-size="8" fill="#243066" text-anchor="middle" pointer-events="none">' + iso + '</text>';
      svg += '</a>';
    });
    // Legend
    var legendY = H - 18;
    svg += '<text x="' + PAD + '" y="' + (legendY - 4) + '" font-size="10" fill="#667">firms per country</text>';
    if (NB) {
      var prev = 0;
      thresholds.forEach(function (t, i) {
        var label = (t === prev) ? ("" + t) : (prev + 1 === t ? ("" + t) : ((prev + 1) + "–" + t));
        prev = t;
        svg += '<rect x="' + (PAD + 110 + i * 64) + '" y="' + legendY + '" width="14" height="10" fill="' + bucketColor(i) + '"/>';
        svg += '<text x="' + (PAD + 128 + i * 64) + '" y="' + (legendY + 9) + '" font-size="10" fill="#243066">' + label + '</text>';
      });
    } else {
      svg += '<text x="' + (PAD + 110) + '" y="' + (legendY + 9) + '" font-size="10" fill="#8b94c2">no countries tagged yet</text>';
    }
    svg += '</svg>';
    // Unmapped countries fallback (kept compact under the map). Excludes the
    // "__unknown__" bucket — that coverage gap is surfaced explicitly below.
    var unmapped = (data || []).filter(function (r) {
      var iso = String(r.country == null ? "" : r.country).toUpperCase();
      return iso && iso !== "__UNKNOWN__" && !COUNTRY_TILES[iso];
    });
    if (unmapped.length) {
      svg += '<div class="ads-muted" style="margin-top:6px;font-size:11px">Other: ' + unmapped.slice(0, 12).map(function (r) {
        return '<a href="/dashboard/firms/?country=' + esc(String(r.country).toLowerCase()) + '">' + esc(r.country) + ' (' + r.count + ')</a>';
      }).join(", ") + '</div>';
    }
    // Coverage note: how many firms have no resolved HQ country.
    if (unknownCount > 0) {
      var pct = total ? Math.round(unknownCount * 100 / total) : 0;
      svg += '<div class="ads-muted" style="margin-top:6px;font-size:11px">' +
        unknownCount + ' firm' + (unknownCount === 1 ? '' : 's') +
        ' have no HQ country assigned (' + pct + '% of ' + total + ').</div>';
    }
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
      var rows = document.querySelectorAll("#ads-fa-heatmap tbody tr");
      rows.forEach(function (tr, ri) {
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
      setText("ads-fa-geo", worldMap(data.items || []));
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
        return '<tr><td><a href="/dashboard/firms/detail/?id=' + f.id + '">' + esc(f.name) + '</a></td><td>' + esc(f.hq_country_iso2 || "") + '</td><td>' + (f.website ? '<a href="' + esc(f.website) + '" target="_blank" rel="noopener">' + esc(f.website.replace(/^https?:\/\//, "")) + '</a>' : "") + '</td></tr>';
      }).join("");
      setText("ads-fa-gaps", '<div class="ads-table-wrap"><table class="ads-table" style="width:100%;border-collapse:collapse"><thead><tr><th>Firm</th><th>Country</th><th>Website</th></tr></thead><tbody>' + (rows || '<tr><td colspan="3" class="ads-muted">No gaps.</td></tr>') + '</tbody></table></div>');
    }).catch(function () { fail("ads-fa-gaps"); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    loadFunnel(); loadTimeline(); loadCheckDist(); loadAumDist();
    loadHeatmap(); loadGeo(); loadConnected(); loadSuccess(); loadRoi(); loadGaps();
    document.getElementById("ads-fa-check-buckets").addEventListener("change", loadCheckDist);
    document.getElementById("ads-fa-success-min").addEventListener("change", loadSuccess);
  });
})();
