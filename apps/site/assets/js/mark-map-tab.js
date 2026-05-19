// Task #9: Valuation Mark-Map tab.
//
// Renders every observed valuation mark on a per-company timeline
// (primary rounds, secondary listings, 409A, mutual-fund N-PORT,
// markdowns), the confidence-weighted blended monthly line, and an
// "Implied valuation" panel pulled from the most relevant comp panel.
//
// Pure DOM + SVG; no chart library.

(function () {
  var API = (window.ADS_API_BASE || "https://api.aidatasignal.com").replace(/\/+$/, "");

  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return "—";
    var abs = Math.abs(v);
    if (abs >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + v.toFixed(0);
  }
  function fmtPct(v) {
    if (v == null || !isFinite(v)) return "—";
    return (v * 100).toFixed(1) + "%";
  }

  var COLORS = {
    primary_round: "#2563eb",
    secondary_listing: "#16a34a",
    four_oh_nine_a: "#f59e0b",
    mutual_fund_holding: "#7c3aed",
    markdown: "#dc2626",
  };
  var LABELS = {
    primary_round: "Primary round",
    secondary_listing: "Secondary",
    four_oh_nine_a: "409A",
    mutual_fund_holding: "Mutual fund",
    markdown: "Markdown",
  };

  function renderSvg(marks, blended) {
    var W = 720, H = 280, PAD = { l: 60, r: 16, t: 16, b: 36 };
    var iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    var withVal = marks.filter(function (m) { return m.implied_valuation_usd != null; });
    if (!withVal.length) return '<div class="ads-muted" style="font-size:12px">No valuation marks recorded yet.</div>';
    var vals = withVal.map(function (m) { return m.implied_valuation_usd; });
    blended.forEach(function (b) { vals.push(b.blended_valuation_usd); });
    var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
    if (vmin === vmax) { vmin = vmin * 0.5; vmax = vmax * 1.5 || 1; }
    var dates = withVal.map(function (m) { return Date.parse(m.as_of); });
    var dmin = Math.min.apply(null, dates), dmax = Math.max.apply(null, dates);
    if (dmin === dmax) { dmax = dmin + 86400000; }
    function x(d) { return PAD.l + (d - dmin) / (dmax - dmin) * iw; }
    function y(v) { return PAD.t + ih - (v - vmin) / (vmax - vmin) * ih; }
    var parts = [];
    parts.push('<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;height:auto;background:#fafafa;border:1px solid #e5e7eb;border-radius:6px">');
    // Y-axis ticks (5 levels)
    for (var i = 0; i <= 4; i++) {
      var yt = PAD.t + (ih * i / 4);
      var vt = vmax - (vmax - vmin) * (i / 4);
      parts.push('<line x1="' + PAD.l + '" y1="' + yt + '" x2="' + (W - PAD.r) + '" y2="' + yt + '" stroke="#e5e7eb" stroke-width="1"/>');
      parts.push('<text x="' + (PAD.l - 4) + '" y="' + (yt + 3) + '" text-anchor="end" font-size="10" fill="#6b7280">' + fmtUsd(vt) + '</text>');
    }
    // X-axis date labels (4 across)
    for (var k = 0; k <= 3; k++) {
      var xt = PAD.l + (iw * k / 3);
      var dt = new Date(dmin + (dmax - dmin) * (k / 3));
      var lbl = dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0");
      parts.push('<text x="' + xt + '" y="' + (H - 14) + '" text-anchor="middle" font-size="10" fill="#6b7280">' + lbl + '</text>');
    }
    // Blended line
    if (blended.length > 1) {
      var path = blended.map(function (b, idx) {
        var ts = Date.parse(b.month + "-15");
        return (idx === 0 ? "M" : "L") + x(ts) + "," + y(b.blended_valuation_usd);
      }).join(" ");
      parts.push('<path d="' + path + '" fill="none" stroke="#111827" stroke-width="2" stroke-dasharray="4,2" opacity="0.6"/>');
    }
    // Marks
    withVal.forEach(function (m) {
      var cx = x(Date.parse(m.as_of)), cy = y(m.implied_valuation_usd);
      var col = COLORS[m.source_kind] || "#6b7280";
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (3 + m.confidence * 4) + '" fill="' + col + '" fill-opacity="0.75" stroke="' + col + '" stroke-width="1"><title>' +
        (LABELS[m.source_kind] || m.source_kind) + " · " + m.as_of + " · " + fmtUsd(m.implied_valuation_usd) +
        (m.notes ? " · " + m.notes.replace(/[<>&]/g, "") : "") + '</title></circle>');
    });
    parts.push('</svg>');
    // Legend
    var legend = ['<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11px">'];
    Object.keys(LABELS).forEach(function (k) {
      legend.push('<span><span style="display:inline-block;width:8px;height:8px;background:' + COLORS[k] + ';border-radius:50%;margin-right:4px"></span>' + LABELS[k] + '</span>');
    });
    legend.push('<span style="color:#6b7280">— blended (confidence-weighted)</span>');
    legend.push('</div>');
    return parts.join("") + legend.join("");
  }

  function renderMarksTable(marks) {
    if (!marks.length) return "";
    var rows = marks.slice().reverse().map(function (m) {
      var pill = '<span style="background:' + (COLORS[m.source_kind] || "#6b7280") + ';color:#fff;border-radius:3px;padding:1px 6px;font-size:10px">' + (LABELS[m.source_kind] || m.source_kind) + '</span>';
      var ev = m.source_url ? '<a href="' + m.source_url + '" target="_blank" rel="noopener">evidence</a>' : "—";
      return '<tr><td>' + m.as_of + '</td><td>' + pill + '</td><td style="text-align:right">' + fmtUsd(m.implied_valuation_usd) + '</td><td style="text-align:right">' + (m.confidence * 100).toFixed(0) + '%</td><td>' + (m.mark_kind || "") + '</td><td>' + (m.holder_name_raw || "") + '</td><td>' + ev + '</td></tr>';
    }).join("");
    return '<table class="ads-table" style="width:100%;font-size:12px;margin-top:8px"><thead><tr><th>As-of</th><th>Source</th><th style="text-align:right">Valuation</th><th style="text-align:right">Conf.</th><th>Kind</th><th>Holder</th><th>Evidence</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderPeers(snap) {
    if (!snap || !snap.members || !snap.members.length) return "";
    var pubs = snap.members.filter(function (m) { return m.is_public; }).slice(0, 8);
    if (!pubs.length) return "";
    var rows = pubs.map(function (m) {
      return '<tr><td>' + (m.ticker ? '<strong>' + m.ticker + '</strong> · ' : "") + m.company_name + '</td>' +
        '<td style="text-align:right">' + (m.ev_arr_multiple != null ? m.ev_arr_multiple.toFixed(1) + "x" : "—") + '</td>' +
        '<td style="text-align:right">' + (m.ev_revenue_multiple != null ? m.ev_revenue_multiple.toFixed(1) + "x" : "—") + '</td>' +
        '<td style="text-align:right">' + (m.growth_yoy_pct != null ? fmtPct(m.growth_yoy_pct) : "—") + '</td>' +
        '<td style="text-align:right">' + (m.rule_of_40_pct != null ? fmtPct(m.rule_of_40_pct) : "—") + '</td></tr>';
    }).join("");
    return '<div style="margin-top:10px"><div style="font-weight:600;font-size:12px;margin-bottom:4px">Public peers · ' + snap.name + '</div>' +
      '<table class="ads-table" style="width:100%;font-size:11px"><thead><tr><th>Company</th><th style="text-align:right">EV/ARR</th><th style="text-align:right">EV/Rev</th><th style="text-align:right">Growth YoY</th><th style="text-align:right">Rule of 40</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function renderMarkdownCallout(marks) {
    var mds = marks.filter(function (m) { return m.source_kind === "markdown"; });
    if (!mds.length) return "";
    var latest = mds.slice().sort(function (a, b) { return b.as_of.localeCompare(a.as_of); })[0];
    return '<div class="ads-card" style="padding:8px;margin-top:8px;border-left:3px solid ' + COLORS.markdown + ';background:#fef2f2">' +
      '<div style="font-weight:600;font-size:12px;color:' + COLORS.markdown + '">Markdown alert</div>' +
      '<div style="font-size:12px">Latest markdown ' + latest.as_of + ' → ' + fmtUsd(latest.implied_valuation_usd) +
      (latest.holder_name_raw ? ' (' + latest.holder_name_raw + ')' : "") +
      (latest.source_url ? ' · <a href="' + latest.source_url + '" target="_blank" rel="noopener">evidence</a>' : "") +
      '</div></div>';
  }

  function renderImplied(iv) {
    if (!iv || iv.basis === "none") return '<div class="ads-muted" style="font-size:12px;margin-top:8px">No implied-valuation range available.</div>';
    var basis = iv.basis === "ev_arr" ? "EV/ARR" : iv.basis === "ev_revenue" ? "EV/Revenue" : "Latest mark";
    var html = '<div class="ads-card" style="padding:8px;margin-top:12px;background:#f9fafb">' +
      '<div style="font-weight:600;font-size:13px;margin-bottom:4px">Implied valuation · ' + basis + '</div>' +
      '<div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px">' +
      '<div><div style="color:#6b7280">Low</div><div>' + fmtUsd(iv.low_usd) + '</div></div>' +
      '<div><div style="color:#6b7280">Median</div><div style="font-weight:600">' + fmtUsd(iv.median_usd) + '</div></div>' +
      '<div><div style="color:#6b7280">High</div><div>' + fmtUsd(iv.high_usd) + '</div></div>';
    if (iv.multiple_median != null) {
      html += '<div><div style="color:#6b7280">Multiple (p25/p50/p75)</div><div>' + iv.multiple_low.toFixed(1) + 'x / ' + iv.multiple_median.toFixed(1) + 'x / ' + iv.multiple_high.toFixed(1) + 'x</div></div>';
    }
    if (iv.panel_name) {
      html += '<div><div style="color:#6b7280">Comp panel</div><div>' + iv.panel_name + '</div></div>';
    }
    html += '</div>';
    if (iv.notes) html += '<div style="color:#6b7280;font-size:11px;margin-top:4px">' + iv.notes + '</div>';
    html += '</div>';
    return html;
  }

  async function mount(opts) {
    var root = document.getElementById(opts.rootId);
    if (!root) return;
    root.innerHTML = '<div class="ads-loading">Loading valuation marks…</div>';
    try {
      var [marksR, ivR] = await Promise.all([
        fetch(API + "/api/companies/" + encodeURIComponent(opts.entityId) + "/marks", { credentials: "include" }),
        fetch(API + "/api/companies/" + encodeURIComponent(opts.entityId) + "/implied-valuation", { credentials: "include" }),
      ]);
      var marksJson = marksR.ok ? await marksR.json() : { marks: [], blended_line: [] };
      var ivJson = ivR.ok ? await ivR.json() : null;
      var marks = marksJson.marks || [];
      var blended = marksJson.blended_line || [];
      // If implied valuation references a comp panel, fetch its snapshot
      // so we can surface the public peers driving the multiple range.
      var snap = null;
      if (ivJson && ivJson.panel_id) {
        try {
          var snapR = await fetch(API + "/api/comp-panels/" + encodeURIComponent(ivJson.panel_id) + "/snapshot", { credentials: "include" });
          if (snapR.ok) snap = await snapR.json();
        } catch (_) { /* peer panel is optional enhancement */ }
      }
      var html = renderSvg(marks, blended)
        + renderMarkdownCallout(marks)
        + renderImplied(ivJson)
        + renderPeers(snap)
        + renderMarksTable(marks);
      root.innerHTML = html;
    } catch (e) {
      root.innerHTML = '<div class="ads-muted" style="font-size:12px">Mark map unavailable: ' + e.message + '</div>';
    }
  }

  window.ADS = window.ADS || {};
  window.ADS.MarkMap = { mount: mount };
})();
