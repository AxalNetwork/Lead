// Tiny dependency-free SVG chart helpers. Each function takes raw data and
// returns an SVG string ready to drop into innerHTML. No external CDNs.
(function () {
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  // Line chart: points = [{day:'2025-01-01', new_leads:N, verified:V}, ...]
  // Renders two stacked series on a 320×120 SVG with axis labels.
  function lineChart(points, opts) {
    opts = opts || {};
    var W = opts.width || 640, H = opts.height || 160, PAD = 28;
    var keys = opts.keys || ["new_leads", "verified"];
    var colors = opts.colors || ["#5b8cff", "#23d6a4"];
    if (!points || !points.length) return '<div class="ads-empty">No data</div>';
    var maxY = 1;
    points.forEach(function (p) {
      keys.forEach(function (k) { if (typeof p[k] === "number" && p[k] > maxY) maxY = p[k]; });
    });
    var n = points.length;
    var dx = (W - PAD * 2) / Math.max(1, n - 1);
    var dy = (H - PAD * 2) / maxY;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">';
    // Axes
    svg += '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" stroke="#243066" stroke-width="1"/>';
    svg += '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + PAD + '" y2="' + (H - PAD) + '" stroke="#243066" stroke-width="1"/>';
    // Y-axis labels (max + mid + 0)
    [0, 0.5, 1].forEach(function (f) {
      var y = (H - PAD) - (H - PAD * 2) * f;
      var v = Math.round(maxY * f);
      svg += '<text x="' + (PAD - 6) + '" y="' + (y + 4) + '" fill="#8b94c2" font-size="10" text-anchor="end">' + v + '</text>';
    });
    // Series
    keys.forEach(function (k, i) {
      var d = "";
      points.forEach(function (p, j) {
        var x = PAD + dx * j;
        var y = (H - PAD) - (p[k] || 0) * dy;
        d += (j ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      });
      svg += '<path d="' + d + '" fill="none" stroke="' + colors[i] + '" stroke-width="2"/>';
      points.forEach(function (p, j) {
        var x = PAD + dx * j;
        var y = (H - PAD) - (p[k] || 0) * dy;
        svg += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2" fill="' + colors[i] + '"><title>' + esc(p.day) + ' ' + esc(k) + ': ' + (p[k] || 0) + '</title></circle>';
      });
    });
    // X-axis labels (first, mid, last)
    [0, Math.floor(n / 2), n - 1].forEach(function (j) {
      var x = PAD + dx * j;
      var lbl = (points[j].day || "").slice(5);
      svg += '<text x="' + x.toFixed(1) + '" y="' + (H - PAD + 12) + '" fill="#8b94c2" font-size="10" text-anchor="middle">' + esc(lbl) + '</text>';
    });
    // Legend
    var lx = PAD + 6, ly = PAD - 8;
    keys.forEach(function (k, i) {
      svg += '<rect x="' + lx + '" y="' + (ly - 8) + '" width="10" height="10" fill="' + colors[i] + '"/>';
      svg += '<text x="' + (lx + 14) + '" y="' + ly + '" fill="#e6ebff" font-size="11">' + esc(k) + '</text>';
      lx += 90;
    });
    svg += '</svg>';
    return svg;
  }

  // Sparkline (24 buckets per series, stacked).
  function sparkline(series, opts) {
    opts = opts || {};
    var W = opts.width || 200, H = opts.height || 40;
    var keys = Object.keys(series || {});
    if (!keys.length) return '<span class="ads-muted" style="font-size:11px">no traffic</span>';
    var n = 24;
    var totals = new Array(n).fill(0);
    keys.forEach(function (k) { (series[k] || []).forEach(function (v, i) { totals[i] += v; }); });
    var maxY = Math.max.apply(null, totals.concat([1]));
    var dx = W / n;
    var palette = ["#5b8cff", "#23d6a4", "#ffb547", "#ff5d6c", "#a085ff", "#8b94c2"];
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">';
    for (var i = 0; i < n; i++) {
      var y = H;
      keys.forEach(function (k, ki) {
        var v = (series[k] || [])[i] || 0;
        var h = (v / maxY) * (H - 2);
        if (h <= 0) return;
        svg += '<rect x="' + (i * dx).toFixed(1) + '" y="' + (y - h).toFixed(1) + '" width="' + (dx - 1).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + palette[ki % palette.length] + '" opacity="0.85"/>';
        y -= h;
      });
    }
    svg += '</svg>';
    return svg;
  }

  // Horizontal bar chart for ranked items: items = [{label, value}]
  function barChart(items, opts) {
    opts = opts || {};
    var max = 1;
    items.forEach(function (i) { if (i.value > max) max = i.value; });
    var html = '<div class="ads-bars">';
    items.forEach(function (i) {
      var pct = Math.round((i.value / max) * 100);
      var fmt = opts.format ? opts.format(i.value) : i.value;
      html += '<div class="ads-bar"><div class="ads-bar__label">' + esc(i.label) + '</div>' +
        '<div class="ads-bar__track"><div class="ads-bar__fill" style="width:' + pct + '%;background:' + (opts.color || '#5b8cff') + '"></div></div>' +
        '<div class="ads-bar__value">' + esc(fmt) + '</div></div>';
    });
    html += '</div>';
    return html;
  }

  // Funnel widget. stages = [{status, count}]
  function funnel(stages) {
    if (!stages || !stages.length) return '<div class="ads-empty">No funnel data</div>';
    var max = stages[0].count || 1;
    var html = '<div class="ads-funnel">';
    stages.forEach(function (s) {
      var pct = Math.round(((s.count || 0) / max) * 100);
      html += '<div class="ads-funnel__row">' +
        '<div class="ads-funnel__label">' + esc(s.status) + '</div>' +
        '<div class="ads-funnel__bar"><div class="ads-funnel__fill" style="width:' + pct + '%"></div></div>' +
        '<div class="ads-funnel__count">' + (s.count || 0) + '</div>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }

  // Heatmap. countries = ["US",...]; sectors = ["fintech",...]; matrix = [[n,...],...]
  function heatmap(countries, sectors, matrix) {
    if (!countries.length || !sectors.length) return '<div class="ads-empty">No segment data</div>';
    var max = 1;
    matrix.forEach(function (row) { row.forEach(function (v) { if (v > max) max = v; }); });
    var html = '<table class="ads-heatmap"><thead><tr><th></th>';
    sectors.forEach(function (s) { html += '<th>' + esc(s) + '</th>'; });
    html += '</tr></thead><tbody>';
    countries.forEach(function (c, ci) {
      html += '<tr><th>' + esc(c) + '</th>';
      (matrix[ci] || []).forEach(function (v) {
        var alpha = v ? (0.15 + 0.85 * (v / max)).toFixed(2) : 0;
        html += '<td title="' + v + '" style="background:rgba(91,140,255,' + alpha + ')">' + (v || '') + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // Quality breakdown (radial 0..1 ring)
  function qualityRing(score, opts) {
    opts = opts || {};
    var W = opts.size || 100;
    var pct = Math.max(0, Math.min(1, score));
    var R = 36, C = 2 * Math.PI * R;
    var off = C * (1 - pct);
    var color = pct > 0.7 ? "#23d6a4" : pct > 0.4 ? "#ffb547" : "#ff5d6c";
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:' + W + 'px;height:' + W + 'px">' +
      '<circle cx="50" cy="50" r="' + R + '" stroke="#243066" stroke-width="8" fill="none"/>' +
      '<circle cx="50" cy="50" r="' + R + '" stroke="' + color + '" stroke-width="8" fill="none" ' +
      'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" stroke-linecap="round" transform="rotate(-90 50 50)"/>' +
      '<text x="50" y="55" text-anchor="middle" fill="#fff" font-size="20" font-weight="700">' + Math.round(pct * 100) + '</text>' +
      '</svg>';
  }

  window.adsCharts = { lineChart: lineChart, sparkline: sparkline, barChart: barChart, funnel: funnel, heatmap: heatmap, qualityRing: qualityRing };
})();
