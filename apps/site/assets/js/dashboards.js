// Task #4: shared front-end loader for the eight VC/PE/Angel dashboard
// pages. Implements the page-level gate (per replit.md Task #2
// precedent), shared SVG chart primitives (bubble map, sankey,
// box-plot, heatmap, world-arcs), CSV export wiring, and snapshot
// create/load.
//
// Public namespace: window.adsDashboards.
//   .gate(page)                        — pre-flight; on 200 reveal #dashboard-content
//   .api(path, opts?)                  — fetch JSON from /api/dashboards/<path>
//   .csv(path, filename, qs?)          — trigger CSV download of the same endpoint
//   .snapshot(page, filters, payload)  — POST /api/dashboards/snapshots
//   .charts.bubble(el, items, opts?)
//   .charts.sankey(el, links, opts?)
//   .charts.boxPlot(el, items, opts?)
//   .charts.heatmap(el, items, opts?)
//   .charts.worldArcs(el, items, opts?)
(function () {
  var API = window.ADS_API_BASE + "/api/dashboards";
  // Shared helpers (window.adsUtil from ads-utils.js, loaded first in <head>).
  var esc = window.adsUtil.escapeHtml;
  var fmtUsd = window.adsUtil.fmtUsd;
  function qs(params) {
    if (!params) return "";
    var p = Object.keys(params).filter(function (k) { return params[k] != null && params[k] !== ""; })
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
    return p ? "?" + p : "";
  }
  // Delegates to the shared adsUtil.apiFetch; keeps the dashboards-specific
  // 401/403 → showForbidden() behavior by inspecting err.status.
  async function api(path, opts) {
    try {
      return await window.adsUtil.apiFetch(API + path, opts);
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403)) { showForbidden(); throw new Error("forbidden"); }
      throw e;
    }
  }
  function csvDownload(path, filename, params) {
    var url = API + path + qs(Object.assign({ format: "csv" }, params || {}));
    var a = document.createElement("a");
    a.href = url; a.download = (filename || "export") + ".csv";
    a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
  }
  function showForbidden() {
    var chk = document.getElementById("dashboard-auth-check");
    if (chk) chk.hidden = true;
    var content = document.getElementById("dashboard-content");
    if (content) { content.hidden = true; content.innerHTML = ""; }
    var f = document.getElementById("dashboard-forbidden");
    if (f) f.hidden = false;
  }
  function revealContent() {
    var chk = document.getElementById("dashboard-auth-check");
    if (chk) chk.hidden = true;
    var content = document.getElementById("dashboard-content");
    if (content) content.hidden = false;
  }
  async function gate(/* page */) {
    try {
      await api("/kpi");
      revealContent();
      return true;
    } catch (_e) { return false; }
  }
  async function snapshot(page, filters, payload) {
    return api("/snapshots", {
      method: "POST",
      body: JSON.stringify({ page: page, filters: filters, payload: payload, row_count: Array.isArray(payload && payload.items) ? payload.items.length : 0 }),
    });
  }

  // ---------------- shared SVG chart primitives ----------------
  // Dependency-free SVG (matches the conventions in charts.js / ops-crawler.js).
  function bubble(el, items, opts) {
    opts = opts || {}; var W = opts.width || 720, H = opts.height || 260, PAD = 30;
    if (!items || !items.length) { el.innerHTML = '<div class="ads-empty">No data.</div>'; return; }
    var sizeKey = opts.sizeKey || "dry_powder_usd";
    var labelKey = opts.labelKey || "firm_name";
    var maxV = Math.max.apply(null, items.map(function (i) { return Number(i[sizeKey]) || 0; }));
    if (maxV <= 0) maxV = 1;
    var cols = Math.ceil(Math.sqrt(items.length * (W / H)));
    var rows = Math.ceil(items.length / cols);
    var cellW = (W - PAD * 2) / cols;
    var cellH = (H - PAD * 2) / rows;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;background:#0f1115;border-radius:6px">';
    items.forEach(function (it, idx) {
      var col = idx % cols, row = Math.floor(idx / cols);
      var cx = PAD + cellW * col + cellW / 2;
      var cy = PAD + cellH * row + cellH / 2;
      var r = Math.max(6, Math.sqrt(Number(it[sizeKey]) || 0) / Math.sqrt(maxV) * Math.min(cellW, cellH) / 2);
      var fill = "#5b8cff";
      svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + fill + '" fill-opacity="0.55" stroke="' + fill + '"><title>' + esc(it[labelKey]) + ' — ' + esc(fmtUsd(it[sizeKey])) + '</title></circle>';
      if (r > 16) {
        svg += '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="middle" font-size="10" fill="#e3e6eb" pointer-events="none">' + esc((it[labelKey] || "").slice(0, 14)) + '</text>';
      }
    });
    svg += "</svg>";
    el.innerHTML = svg;
  }
  function sankey(el, links, opts) {
    opts = opts || {}; var W = opts.width || 760, H = opts.height || 360, PAD = 12;
    if (!links || !links.length) { el.innerHTML = '<div class="ads-empty">No movements in window.</div>'; return; }
    var fromSet = {}, toSet = {};
    links.forEach(function (l) { fromSet[l.from_firm_entity_id] = (fromSet[l.from_firm_entity_id] || 0) + l.count; toSet[l.to_firm_entity_id] = (toSet[l.to_firm_entity_id] || 0) + l.count; });
    var fromList = Object.keys(fromSet).sort(function (a, b) { return fromSet[b] - fromSet[a]; }).slice(0, 20);
    var toList = Object.keys(toSet).sort(function (a, b) { return toSet[b] - toSet[a]; }).slice(0, 20);
    var fromTotal = fromList.reduce(function (s, k) { return s + fromSet[k]; }, 0);
    var toTotal = toList.reduce(function (s, k) { return s + toSet[k]; }, 0);
    var leftX = PAD + 80, rightX = W - PAD - 80, barW = 10;
    var fromY = {}, toY = {};
    var y = PAD;
    fromList.forEach(function (k) { var h = (fromSet[k] / fromTotal) * (H - PAD * 2); fromY[k] = { y: y, h: h }; y += h + 2; });
    y = PAD;
    toList.forEach(function (k) { var h = (toSet[k] / toTotal) * (H - PAD * 2); toY[k] = { y: y, h: h }; y += h + 2; });
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;background:#0f1115;border-radius:6px">';
    fromList.forEach(function (k) {
      var f = fromY[k];
      svg += '<rect x="' + leftX + '" y="' + f.y + '" width="' + barW + '" height="' + f.h + '" fill="#5b8cff"><title>' + esc(k) + ' — ' + fromSet[k] + ' out</title></rect>';
      svg += '<text x="' + (leftX - 4) + '" y="' + (f.y + f.h / 2) + '" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#aab3bf">' + esc(k.slice(0, 14)) + '</text>';
    });
    toList.forEach(function (k) {
      var t = toY[k];
      svg += '<rect x="' + rightX + '" y="' + t.y + '" width="' + barW + '" height="' + t.h + '" fill="#23d6a4"><title>' + esc(k) + ' — ' + toSet[k] + ' in</title></rect>';
      svg += '<text x="' + (rightX + barW + 4) + '" y="' + (t.y + t.h / 2) + '" text-anchor="start" dominant-baseline="middle" font-size="9" fill="#aab3bf">' + esc(k.slice(0, 14)) + '</text>';
    });
    var fromOff = {}, toOff = {};
    links.forEach(function (l) {
      if (!(l.from_firm_entity_id in fromY) || !(l.to_firm_entity_id in toY)) return;
      var f = fromY[l.from_firm_entity_id], t = toY[l.to_firm_entity_id];
      var fhShare = (l.count / fromSet[l.from_firm_entity_id]) * f.h;
      var thShare = (l.count / toSet[l.to_firm_entity_id]) * t.h;
      var fOff = fromOff[l.from_firm_entity_id] || 0;
      var tOff = toOff[l.to_firm_entity_id] || 0;
      var y0 = f.y + fOff, y1 = t.y + tOff;
      fromOff[l.from_firm_entity_id] = fOff + fhShare;
      toOff[l.to_firm_entity_id] = tOff + thShare;
      var midX = (leftX + barW + rightX) / 2;
      var path = "M " + (leftX + barW) + " " + (y0 + fhShare / 2)
        + " C " + midX + " " + (y0 + fhShare / 2)
        + ", " + midX + " " + (y1 + thShare / 2)
        + ", " + rightX + " " + (y1 + thShare / 2);
      svg += '<path d="' + path + '" stroke="#5b8cff" stroke-opacity="0.35" stroke-width="' + Math.max(1, fhShare) + '" fill="none"><title>' + esc(l.from_firm_entity_id) + ' → ' + esc(l.to_firm_entity_id) + ' (' + l.count + ')</title></path>';
    });
    svg += "</svg>";
    el.innerHTML = svg;
  }
  function boxPlot(el, items, opts) {
    opts = opts || {}; var W = opts.width || 760, H = opts.height || 280, PAD = 30;
    if (!items || !items.length) { el.innerHTML = '<div class="ads-empty">No vintage data.</div>'; return; }
    var sorted = items.slice().sort(function (a, b) {
      return a.vintage_year - b.vintage_year || a.strategy.localeCompare(b.strategy);
    });
    var maxV = Math.max.apply(null, sorted.map(function (i) { return Number(i.max) || 0; }));
    var minV = Math.min.apply(null, sorted.map(function (i) { return Number(i.min) || 0; }));
    if (maxV === minV) { maxV = minV + 1; }
    var bw = (W - PAD * 2) / sorted.length;
    var scaleY = function (v) { return H - PAD - (v - minV) / (maxV - minV) * (H - PAD * 2); };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;background:#0f1115;border-radius:6px">';
    sorted.forEach(function (it, i) {
      var cx = PAD + bw * i + bw / 2;
      svg += '<line x1="' + cx + '" y1="' + scaleY(it.min) + '" x2="' + cx + '" y2="' + scaleY(it.max) + '" stroke="#aab3bf" />';
      svg += '<rect x="' + (cx - bw * 0.3) + '" y="' + scaleY(it.q3) + '" width="' + (bw * 0.6) + '" height="' + (scaleY(it.q1) - scaleY(it.q3)) + '" fill="#5b8cff" fill-opacity="0.4" stroke="#5b8cff"><title>' + esc(it.vintage_year) + " " + esc(it.strategy) + " · n=" + it.n + "</title></rect>";
      svg += '<line x1="' + (cx - bw * 0.3) + '" y1="' + scaleY(it.median) + '" x2="' + (cx + bw * 0.3) + '" y2="' + scaleY(it.median) + '" stroke="#e3e6eb" stroke-width="2"/>';
      if (i % Math.ceil(sorted.length / 12) === 0) {
        svg += '<text x="' + cx + '" y="' + (H - 4) + '" text-anchor="middle" font-size="9" fill="#aab3bf">' + esc(it.vintage_year) + "</text>";
      }
    });
    svg += "</svg>";
    el.innerHTML = svg;
  }
  function heatmap(el, items, opts) {
    opts = opts || {}; var W = opts.width || 760, PAD = 80;
    if (!items || !items.length) { el.innerHTML = '<div class="ads-empty">No deals in window.</div>'; return; }
    var sectorSet = {}, monthSet = {};
    items.forEach(function (it) { sectorSet[it.sector] = true; monthSet[it.month] = true; });
    var sectors = Object.keys(sectorSet).sort();
    var months = Object.keys(monthSet).sort();
    var key = function (s, m) { return s + "|" + m; };
    var data = {};
    items.forEach(function (it) { data[key(it.sector, it.month)] = it; });
    var metric = opts.metric || "deal_count";
    var maxV = Math.max.apply(null, items.map(function (i) { return Number(i[metric]) || 0; }));
    if (maxV <= 0) maxV = 1;
    var cellW = (W - PAD) / Math.max(1, months.length);
    var cellH = 22;
    var H = PAD / 2 + sectors.length * cellH + 20;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;background:#0f1115;border-radius:6px">';
    months.forEach(function (m, j) {
      svg += '<text x="' + (PAD + cellW * j + cellW / 2) + '" y="' + (PAD / 2 - 2) + '" text-anchor="middle" font-size="9" fill="#aab3bf">' + esc(m) + "</text>";
    });
    sectors.forEach(function (s, i) {
      svg += '<text x="' + (PAD - 4) + '" y="' + (PAD / 2 + cellH * i + cellH / 2) + '" text-anchor="end" dominant-baseline="middle" font-size="10" fill="#e3e6eb">' + esc(s) + "</text>";
      months.forEach(function (m, j) {
        var cell = data[key(s, m)];
        var v = cell ? Number(cell[metric]) || 0 : 0;
        var alpha = v / maxV;
        svg += '<rect x="' + (PAD + cellW * j) + '" y="' + (PAD / 2 + cellH * i) + '" width="' + (cellW - 1) + '" height="' + (cellH - 1) + '" fill="#5b8cff" fill-opacity="' + alpha.toFixed(2) + '"><title>' + esc(s) + " · " + esc(m) + " — " + (cell ? cell.deal_count + " deals · " + fmtUsd(cell.total_usd) : "0") + "</title></rect>";
      });
    });
    svg += "</svg>";
    el.innerHTML = svg;
  }
  function worldArcs(el, items, opts) {
    opts = opts || {}; var W = opts.width || 760, H = opts.height || 360;
    if (!items || !items.length) { el.innerHTML = '<div class="ads-empty">No flows in window.</div>'; return; }
    var top = items.slice(0, 50);
    var maxV = Math.max.apply(null, top.map(function (i) { return Number(i.total_usd) || 0; })) || 1;
    var positions = {};
    var keys = {};
    top.forEach(function (l) { keys[l.from] = true; keys[l.to] = true; });
    var nodeList = Object.keys(keys);
    nodeList.forEach(function (k, idx) {
      var angle = (idx / nodeList.length) * Math.PI * 2;
      var cx = W / 2 + Math.cos(angle) * (W / 2 - 60);
      var cy = H / 2 + Math.sin(angle) * (H / 2 - 60);
      positions[k] = { x: cx, y: cy };
    });
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;background:#0f1115;border-radius:6px">';
    top.forEach(function (l) {
      var p = positions[l.from], q = positions[l.to];
      if (!p || !q) return;
      var mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2 - 40;
      var w = Math.max(0.5, (Number(l.total_usd) / maxV) * 6);
      svg += '<path d="M ' + p.x + ' ' + p.y + ' Q ' + mx + ' ' + my + ' ' + q.x + ' ' + q.y + '" stroke="#23d6a4" stroke-opacity="0.45" stroke-width="' + w.toFixed(1) + '" fill="none"><title>' + esc(l.from) + " → " + esc(l.to) + " · " + l.deal_count + " deals · " + fmtUsd(l.total_usd) + "</title></path>";
    });
    nodeList.forEach(function (k) {
      var p = positions[k];
      svg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="#e3e6eb"/>';
      svg += '<text x="' + p.x + '" y="' + (p.y - 6) + '" text-anchor="middle" font-size="9" fill="#aab3bf">' + esc(k) + "</text>";
    });
    svg += "</svg>";
    el.innerHTML = svg;
  }

  window.adsDashboards = {
    api: api, csv: csvDownload, snapshot: snapshot, gate: gate, esc: esc, fmtUsd: fmtUsd, qs: qs,
    revealContent: revealContent, showForbidden: showForbidden,
    charts: { bubble: bubble, sankey: sankey, boxPlot: boxPlot, heatmap: heatmap, worldArcs: worldArcs },
  };
})();
