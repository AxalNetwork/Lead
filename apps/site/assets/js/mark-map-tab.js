// Task #9: Valuation Mark-Map tab.
//
// Renders every observed valuation mark on a per-company timeline
// (primary rounds, secondary listings, 409A, mutual-fund N-PORT,
// markdowns), the confidence-weighted blended monthly line, and an
// "Implied valuation" panel pulled from the most relevant comp panel.
//
// All rendering uses safe DOM construction (createElement +
// textContent + setAttribute) so attacker-influenced strings from
// scraped/external sources (holder_name_raw, company_name, ticker,
// panel_name, notes, source_url) cannot inject markup or
// javascript: URLs.

(function () {
  var API = (window.ADS_API_BASE).replace(/\/+$/, "");
  var SVG_NS = "http://www.w3.org/2000/svg";

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

  // URL allow-list: only http / https / mailto. Anything else (notably
  // javascript:, data:) is rejected and we render no link.
  function safeHref(url) {
    if (typeof url !== "string") return null;
    var trimmed = url.trim();
    if (!trimmed) return null;
    if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
    return null;
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (attrs[k] == null) continue;
        node.setAttribute(k, String(attrs[k]));
      }
    }
    if (text != null) node.textContent = String(text);
    return node;
  }
  function svgEl(tag, attrs, text) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (attrs[k] == null) continue;
        node.setAttribute(k, String(attrs[k]));
      }
    }
    if (text != null) node.textContent = String(text);
    return node;
  }
  function evidenceLink(url, label) {
    var href = safeHref(url);
    if (!href) return document.createTextNode("—");
    var a = el("a", { href: href, target: "_blank", rel: "noopener noreferrer" }, label || "evidence");
    return a;
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

  function buildSvg(marks, blended) {
    var W = 720, H = 280, PAD = { l: 60, r: 16, t: 16, b: 36 };
    var iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    var withVal = marks.filter(function (m) { return m.implied_valuation_usd != null; });
    if (!withVal.length) {
      return el("div", { "class": "ads-muted", style: "font-size:12px" }, "No valuation marks recorded yet.");
    }
    var vals = withVal.map(function (m) { return m.implied_valuation_usd; });
    blended.forEach(function (b) { vals.push(b.blended_valuation_usd); });
    var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
    if (vmin === vmax) { vmin = vmin * 0.5; vmax = vmax * 1.5 || 1; }
    var dates = withVal.map(function (m) { return Date.parse(m.as_of); });
    var dmin = Math.min.apply(null, dates), dmax = Math.max.apply(null, dates);
    if (dmin === dmax) { dmax = dmin + 86400000; }
    function x(d) { return PAD.l + (d - dmin) / (dmax - dmin) * iw; }
    function y(v) { return PAD.t + ih - (v - vmin) / (vmax - vmin) * ih; }

    var svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + H,
      style: "width:100%;max-width:" + W + "px;height:auto;background:#fafafa;border:1px solid #e5e7eb;border-radius:6px",
    });
    for (var i = 0; i <= 4; i++) {
      var yt = PAD.t + (ih * i / 4);
      var vt = vmax - (vmax - vmin) * (i / 4);
      svg.appendChild(svgEl("line", { x1: PAD.l, y1: yt, x2: W - PAD.r, y2: yt, stroke: "#e5e7eb", "stroke-width": 1 }));
      svg.appendChild(svgEl("text", { x: PAD.l - 4, y: yt + 3, "text-anchor": "end", "font-size": 10, fill: "#6b7280" }, fmtUsd(vt)));
    }
    for (var k = 0; k <= 3; k++) {
      var xt = PAD.l + (iw * k / 3);
      var dt = new Date(dmin + (dmax - dmin) * (k / 3));
      var lbl = dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0");
      svg.appendChild(svgEl("text", { x: xt, y: H - 14, "text-anchor": "middle", "font-size": 10, fill: "#6b7280" }, lbl));
    }
    if (blended.length > 1) {
      var d = blended.map(function (b, idx) {
        var ts = Date.parse(b.month + "-15");
        return (idx === 0 ? "M" : "L") + x(ts) + "," + y(b.blended_valuation_usd);
      }).join(" ");
      svg.appendChild(svgEl("path", { d: d, fill: "none", stroke: "#111827", "stroke-width": 2, "stroke-dasharray": "4,2", opacity: 0.6 }));
    }
    withVal.forEach(function (m) {
      var cx = x(Date.parse(m.as_of)), cy = y(m.implied_valuation_usd);
      var col = COLORS[m.source_kind] || "#6b7280";
      var c = svgEl("circle", {
        cx: cx, cy: cy, r: 3 + m.confidence * 4,
        fill: col, "fill-opacity": 0.75, stroke: col, "stroke-width": 1,
      });
      var title = (LABELS[m.source_kind] || m.source_kind) + " · " + m.as_of + " · " + fmtUsd(m.implied_valuation_usd);
      if (m.notes) title += " · " + m.notes;
      c.appendChild(svgEl("title", null, title));
      svg.appendChild(c);
    });

    var wrap = el("div");
    wrap.appendChild(svg);
    var legend = el("div", { style: "display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11px" });
    Object.keys(LABELS).forEach(function (key) {
      var span = el("span");
      span.appendChild(el("span", {
        style: "display:inline-block;width:8px;height:8px;background:" + COLORS[key] + ";border-radius:50%;margin-right:4px",
      }));
      span.appendChild(document.createTextNode(LABELS[key]));
      legend.appendChild(span);
    });
    legend.appendChild(el("span", { style: "color:#6b7280" }, "— blended (confidence-weighted)"));
    wrap.appendChild(legend);
    return wrap;
  }

  function buildMarksTable(marks) {
    if (!marks.length) return document.createDocumentFragment();
    var table = el("table", { "class": "ads-table", style: "width:100%;font-size:12px;margin-top:8px" });
    var thead = el("thead");
    var headRow = el("tr");
    ["As-of", "Source", "Valuation", "Conf.", "Kind", "Holder", "Evidence"].forEach(function (h, idx) {
      headRow.appendChild(el("th", idx >= 2 && idx <= 3 ? { style: "text-align:right" } : null, h));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = el("tbody");
    marks.slice().reverse().forEach(function (m) {
      var tr = el("tr");
      tr.appendChild(el("td", null, m.as_of));
      var pillTd = el("td");
      pillTd.appendChild(el("span", {
        style: "background:" + (COLORS[m.source_kind] || "#6b7280") + ";color:#fff;border-radius:3px;padding:1px 6px;font-size:10px",
      }, LABELS[m.source_kind] || m.source_kind));
      tr.appendChild(pillTd);
      tr.appendChild(el("td", { style: "text-align:right" }, fmtUsd(m.implied_valuation_usd)));
      tr.appendChild(el("td", { style: "text-align:right" }, (m.confidence * 100).toFixed(0) + "%"));
      tr.appendChild(el("td", null, m.mark_kind || ""));
      tr.appendChild(el("td", null, m.holder_name_raw || ""));
      var evTd = el("td");
      evTd.appendChild(evidenceLink(m.source_url));
      tr.appendChild(evTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function buildPeers(snap) {
    if (!snap || !snap.members || !snap.members.length) return document.createDocumentFragment();
    var pubs = snap.members.filter(function (m) { return m.is_public; }).slice(0, 8);
    if (!pubs.length) return document.createDocumentFragment();
    var wrap = el("div", { style: "margin-top:10px" });
    wrap.appendChild(el("div", { style: "font-weight:600;font-size:12px;margin-bottom:4px" }, "Public peers · " + (snap.name || "")));
    var table = el("table", { "class": "ads-table", style: "width:100%;font-size:11px" });
    var thead = el("thead"); var hr = el("tr");
    hr.appendChild(el("th", null, "Company"));
    ["EV/ARR", "EV/Rev", "Growth YoY", "Rule of 40"].forEach(function (h) {
      hr.appendChild(el("th", { style: "text-align:right" }, h));
    });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = el("tbody");
    pubs.forEach(function (m) {
      var tr = el("tr");
      var nameTd = el("td");
      if (m.ticker) {
        nameTd.appendChild(el("strong", null, m.ticker));
        nameTd.appendChild(document.createTextNode(" · " + (m.company_name || "")));
      } else {
        nameTd.textContent = m.company_name || "";
      }
      tr.appendChild(nameTd);
      tr.appendChild(el("td", { style: "text-align:right" }, m.ev_arr_multiple != null ? m.ev_arr_multiple.toFixed(1) + "x" : "—"));
      tr.appendChild(el("td", { style: "text-align:right" }, m.ev_revenue_multiple != null ? m.ev_revenue_multiple.toFixed(1) + "x" : "—"));
      tr.appendChild(el("td", { style: "text-align:right" }, fmtPct(m.growth_yoy_pct)));
      tr.appendChild(el("td", { style: "text-align:right" }, fmtPct(m.rule_of_40_pct)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // Detect a step-change between consecutive mutual-fund-holding marks
  // (the dominant source kind for both markdowns and markups). A
  // ≥10% drop from one fund report to the next is a "markdown"; a
  // ≥10% lift is a "markup". This keeps parity with the spec's "both
  // markdowns and markups are called out" requirement even when the
  // upstream pipeline hasn't relabelled the source_kind itself.
  function detectMarkChanges(marks) {
    var fundMarks = marks
      .filter(function (m) { return m.source_kind === "mutual_fund_holding" && m.implied_valuation_usd != null; })
      .slice()
      .sort(function (a, b) { return a.as_of.localeCompare(b.as_of); });
    var explicit = marks.filter(function (m) { return m.source_kind === "markdown"; });
    var out = [];
    for (var i = 1; i < fundMarks.length; i++) {
      var prev = fundMarks[i - 1], cur = fundMarks[i];
      var delta = (cur.implied_valuation_usd - prev.implied_valuation_usd) / prev.implied_valuation_usd;
      if (delta <= -0.10) out.push({ kind: "markdown", as_of: cur.as_of, from: prev.implied_valuation_usd, to: cur.implied_valuation_usd, delta: delta, holder: cur.holder_name_raw, source_url: cur.source_url });
      else if (delta >= 0.10) out.push({ kind: "markup", as_of: cur.as_of, from: prev.implied_valuation_usd, to: cur.implied_valuation_usd, delta: delta, holder: cur.holder_name_raw, source_url: cur.source_url });
    }
    explicit.forEach(function (m) {
      out.push({ kind: "markdown", as_of: m.as_of, from: null, to: m.implied_valuation_usd, delta: null, holder: m.holder_name_raw, source_url: m.source_url });
    });
    return out.sort(function (a, b) { return b.as_of.localeCompare(a.as_of); });
  }

  function buildMarkdownCallout(marks) {
    var changes = detectMarkChanges(marks);
    if (!changes.length) return document.createDocumentFragment();
    var frag = document.createDocumentFragment();
    // Show at most one markdown + one markup callout (latest of each).
    var seen = {};
    changes.forEach(function (c) {
      if (seen[c.kind]) return;
      seen[c.kind] = true;
      var isUp = c.kind === "markup";
      var color = isUp ? COLORS.primary_round : COLORS.markdown;
      var bg = isUp ? "#eff6ff" : "#fef2f2";
      var card = el("div", {
        "class": "ads-card",
        style: "padding:8px;margin-top:8px;border-left:3px solid " + color + ";background:" + bg,
      });
      card.appendChild(el("div", { style: "font-weight:600;font-size:12px;color:" + color },
        isUp ? "Markup alert" : "Markdown alert"));
      var body = el("div", { style: "font-size:12px" });
      var line = "Latest " + c.kind + " " + c.as_of + " → " + fmtUsd(c.to);
      if (c.from != null) line += " (was " + fmtUsd(c.from) + ", " + (c.delta >= 0 ? "+" : "") + (c.delta * 100).toFixed(1) + "%)";
      if (c.holder) line += " · " + c.holder;
      body.appendChild(document.createTextNode(line));
      var href = safeHref(c.source_url);
      if (href) {
        body.appendChild(document.createTextNode(" · "));
        body.appendChild(evidenceLink(c.source_url));
      }
      card.appendChild(body);
      frag.appendChild(card);
    });
    return frag;
  }

  function buildImplied(iv) {
    if (!iv || iv.basis === "none") {
      return el("div", { "class": "ads-muted", style: "font-size:12px;margin-top:8px" }, "No implied-valuation range available.");
    }
    var basis = iv.basis === "ev_arr" ? "EV/ARR" : iv.basis === "ev_revenue" ? "EV/Revenue" : "Latest mark";
    var card = el("div", { "class": "ads-card", style: "padding:8px;margin-top:12px;background:#f9fafb" });
    card.appendChild(el("div", { style: "font-weight:600;font-size:13px;margin-bottom:4px" }, "Implied valuation · " + basis));
    var row = el("div", { style: "display:flex;gap:18px;flex-wrap:wrap;font-size:12px" });
    function stat(label, value, strong) {
      var d = el("div");
      d.appendChild(el("div", { style: "color:#6b7280" }, label));
      d.appendChild(el("div", strong ? { style: "font-weight:600" } : null, value));
      return d;
    }
    row.appendChild(stat("Low", fmtUsd(iv.low_usd)));
    row.appendChild(stat("Median", fmtUsd(iv.median_usd), true));
    row.appendChild(stat("High", fmtUsd(iv.high_usd)));
    if (iv.multiple_median != null) {
      row.appendChild(stat("Multiple (p25/p50/p75)",
        iv.multiple_low.toFixed(1) + "x / " + iv.multiple_median.toFixed(1) + "x / " + iv.multiple_high.toFixed(1) + "x"));
    }
    if (iv.panel_name) row.appendChild(stat("Comp panel", iv.panel_name));
    card.appendChild(row);
    if (iv.notes) card.appendChild(el("div", { style: "color:#6b7280;font-size:11px;margin-top:4px" }, iv.notes));
    return card;
  }

  async function mount(opts) {
    var root = document.getElementById(opts.rootId);
    if (!root) return;
    root.innerHTML = "";
    root.appendChild(el("div", { "class": "ads-loading" }, "Loading valuation marks…"));
    try {
      var [marksR, ivR] = await Promise.all([
        fetch(API + "/api/companies/" + encodeURIComponent(opts.entityId) + "/marks", { credentials: "include" }),
        fetch(API + "/api/companies/" + encodeURIComponent(opts.entityId) + "/implied-valuation", { credentials: "include" }),
      ]);
      var marksJson = marksR.ok ? await marksR.json() : { marks: [], blended_line: [] };
      var ivJson = ivR.ok ? await ivR.json() : null;
      var marks = marksJson.marks || [];
      var blended = marksJson.blended_line || [];
      var snap = null;
      if (ivJson && ivJson.panel_id) {
        try {
          var snapR = await fetch(API + "/api/comp-panels/" + encodeURIComponent(ivJson.panel_id) + "/snapshot", { credentials: "include" });
          if (snapR.ok) snap = await snapR.json();
        } catch (_) { /* peer panel is optional */ }
      }
      root.innerHTML = "";
      root.appendChild(buildSvg(marks, blended));
      root.appendChild(buildMarkdownCallout(marks));
      root.appendChild(buildImplied(ivJson));
      root.appendChild(buildPeers(snap));
      root.appendChild(buildMarksTable(marks));
    } catch (e) {
      root.innerHTML = "";
      root.appendChild(el("div", { "class": "ads-muted", style: "font-size:12px" }, "Mark map unavailable: " + e.message));
    }
  }

  // Exposed for unit-tests (test/markMap.security.test.mjs).
  window.ADS = window.ADS || {};
  window.ADS.MarkMap = { mount: mount, _safeHref: safeHref };
})();
