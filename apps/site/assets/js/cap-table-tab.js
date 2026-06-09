// Task #5: Cap-Table tab.
//
// Public surface (mirrors profile-tab.js):
//   window.ADS.CapTable.mount({ rootId, entityId })
//
// Renders: confidence banner (color-coded by source_kind), summary
// strip (post-money / FD shares / option pool %), sortable holders
// table, and a dilution waterfall (when 2+ snapshots exist).

(function () {
  if (window.ADS && window.ADS.CapTable) return;
  window.ADS = window.ADS || {};
  var API = (window.ADS_API_BASE).replace(/\/+$/, "");

  var SOURCE_LABEL = {
    s1_filing: "S-1 filing (gold)",
    delaware_coi: "Delaware certificate",
    form_d_inference: "Form D inference",
    secondary_listing: "Secondary listing",
    press_inference: "Press release inference",
  };
  var SOURCE_COLOR = {
    s1_filing: "#1c7c2d",
    delaware_coi: "#3a72b5",
    form_d_inference: "#7a5a00",
    secondary_listing: "#7a3a8a",
    press_inference: "#a33",
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtUsd(n) {
    if (n == null) return "—";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
    return "$" + n.toLocaleString();
  }
  function fmtShares(n) { return n == null ? "—" : Number(n).toLocaleString(); }
  function fmtPct(n) { return n == null ? "—" : (n * 100).toFixed(1) + "%"; }

  async function api(path) {
    var res = await fetch(API + path, { credentials: "include" });
    if (!res.ok) throw new Error(path + " -> " + res.status);
    return res.json();
  }

  function renderConfidenceBanner(snap) {
    var color = SOURCE_COLOR[snap.source_kind] || "#666";
    var label = SOURCE_LABEL[snap.source_kind] || snap.source_kind;
    var pct = Math.round((snap.confidence || 0) * 100);
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:' + color + '20;border-left:3px solid ' + color + ';font-size:12px;margin-bottom:8px">' +
      '<strong style="color:' + color + '">' + esc(label) + '</strong>' +
      '<span style="color:#666">confidence ' + pct + '%</span>' +
      '<span style="color:#666">· as of ' + esc(snap.as_of) + '</span>' +
      '<a href="' + esc(snap.source_url) + '" target="_blank" rel="noopener" style="margin-left:auto;font-size:11px">View source →</a>' +
    '</div>';
  }

  function renderSummary(snap) {
    var cells = [
      ["Post-money", fmtUsd(snap.post_money_usd)],
      ["Fully diluted shares", fmtShares(snap.fully_diluted_shares)],
      ["Option pool", fmtPct(snap.option_pool_pct)],
      ["Preferred %", fmtPct(snap.preferred_pct)],
      ["Common %", fmtPct(snap.common_pct)],
    ];
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px">' +
      cells.map(function (c) {
        return '<div style="padding:6px 8px;background:#f7f7f7;border-radius:4px"><div style="font-size:10px;color:#888;text-transform:uppercase">' + esc(c[0]) + '</div><div style="font-size:14px;font-weight:600">' + esc(c[1]) + '</div></div>';
      }).join("") +
    '</div>';
  }

  // Sortable holders table. Click a column header to cycle asc/desc;
  // a small arrow indicates the active direction.
  var SORT_STATE = { key: "pct_ownership", dir: "desc" };
  var COLS = [
    { key: "holder_name", label: "Holder", align: "left", sortVal: function (h) { return (h.holder_name || "").toLowerCase(); } },
    { key: "holder_class", label: "Class", align: "left", sortVal: function (h) { return h.holder_class || ""; } },
    { key: "security_type", label: "Security", align: "left", sortVal: function (h) { return h.security_type || ""; } },
    { key: "shares", label: "Shares", align: "right", sortVal: function (h) { return h.shares == null ? -Infinity : h.shares; } },
    { key: "pct_ownership", label: "%", align: "right", sortVal: function (h) { return h.pct_ownership == null ? -Infinity : h.pct_ownership; } },
    { key: "original_investment_usd", label: "Investment", align: "right", sortVal: function (h) { return h.original_investment_usd == null ? -Infinity : h.original_investment_usd; } },
    { key: "round_acquired", label: "Round", align: "left", sortVal: function (h) { return h.round_acquired || ""; } },
    { key: "evidence", label: "Evidence", align: "left", sortVal: function (h) { return h.evidence_source_kind || ""; } },
  ];

  function sortHolders(holders) {
    var col = COLS.find(function (c) { return c.key === SORT_STATE.key; }) || COLS[4];
    var sign = SORT_STATE.dir === "asc" ? 1 : -1;
    return holders.slice().sort(function (a, b) {
      var va = col.sortVal(a), vb = col.sortVal(b);
      if (va < vb) return -1 * sign;
      if (va > vb) return 1 * sign;
      return 0;
    });
  }

  function renderHoldersTable(holders, mountId) {
    if (!holders || !holders.length) return '<div class="ads-muted" style="font-size:12px">No holders disclosed at this confidence tier.</div>';
    var sorted = sortHolders(holders);
    var thead = COLS.map(function (c) {
      var arrow = SORT_STATE.key === c.key ? (SORT_STATE.dir === "asc" ? " ▲" : " ▼") : "";
      return '<th data-sort="' + c.key + '" style="text-align:' + c.align + ';cursor:pointer;user-select:none">' + esc(c.label) + arrow + '</th>';
    }).join("");
    var rows = sorted.map(function (h) {
      var evidenceCell = "—";
      if (h.evidence_url) {
        var label = h.evidence_source_kind ? h.evidence_source_kind.replace(/_/g, " ") : "source";
        evidenceCell = '<a href="' + esc(h.evidence_url) + '" target="_blank" rel="noopener" style="font-size:11px">' + esc(label) + ' ↗</a>';
        if (h.evidence_accession_no) evidenceCell += ' <span style="font-size:10px;color:#999">' + esc(h.evidence_accession_no) + '</span>';
      }
      return '<tr>' +
        '<td>' + esc(h.holder_name) + (h.holder_entity_id ? ' <a href="/dashboard/profile/?entity=' + encodeURIComponent(h.holder_entity_id) + '" style="font-size:10px">↗</a>' : '') + '</td>' +
        '<td style="font-size:11px;color:#666">' + esc(h.holder_class) + '</td>' +
        '<td style="font-size:11px;color:#666">' + esc(h.security_type || "—") + '</td>' +
        '<td style="text-align:right">' + fmtShares(h.shares) + '</td>' +
        '<td style="text-align:right">' + fmtPct(h.pct_ownership) + '</td>' +
        '<td style="text-align:right">' + fmtUsd(h.original_investment_usd) + '</td>' +
        '<td style="font-size:11px">' + esc(h.round_acquired || "—") + '</td>' +
        '<td style="font-size:11px">' + evidenceCell + '</td>' +
      '</tr>';
    }).join("");
    return '<table class="ads-table" data-holders-table="' + esc(mountId || "") + '" style="width:100%;font-size:12px;border-collapse:collapse">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ddd">' + thead + '</tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  function bindSortHandlers(rootEl, snap) {
    var table = rootEl.querySelector("table[data-holders-table]");
    if (!table) return;
    table.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-sort");
        if (SORT_STATE.key === key) {
          SORT_STATE.dir = SORT_STATE.dir === "asc" ? "desc" : "asc";
        } else {
          SORT_STATE.key = key;
          SORT_STATE.dir = key === "holder_name" || key === "holder_class" || key === "security_type" || key === "round_acquired" ? "asc" : "desc";
        }
        // Re-render only the holders table region.
        var marker = rootEl.querySelector("[data-holders-region]");
        if (marker) marker.innerHTML = renderHoldersTable(snap.holders, "holders-region");
        bindSortHandlers(rootEl, snap);
      });
    });
  }

  function renderDilution(steps) {
    if (!steps || !steps.length) return "";
    var rows = steps.map(function (s) {
      var growth = s.share_growth_ratio == null ? "—" : (s.share_growth_ratio.toFixed(2) + "×");
      var founder = s.founder_pct_change == null ? "—" : ((s.founder_pct_change >= 0 ? "+" : "") + (s.founder_pct_change * 100).toFixed(1) + " pp");
      var pref = s.preferred_pct_change == null ? "—" : ((s.preferred_pct_change >= 0 ? "+" : "") + (s.preferred_pct_change * 100).toFixed(1) + " pp");
      return '<tr>' +
        '<td>' + esc(s.from_as_of) + ' → ' + esc(s.to_as_of) + '</td>' +
        '<td style="font-size:11px;color:#666">' + esc(s.from_source_kind) + ' → ' + esc(s.to_source_kind) + '</td>' +
        '<td style="text-align:right">' + esc(growth) + '</td>' +
        '<td style="text-align:right">' + esc(founder) + '</td>' +
        '<td style="text-align:right">' + esc(pref) + '</td>' +
        '<td style="text-align:right">' + fmtUsd(s.to_post_money_usd) + '</td>' +
      '</tr>';
    }).join("");
    return '<h4 style="margin:16px 0 6px;font-size:13px">Dilution waterfall</h4>' +
      '<table class="ads-table" style="width:100%;font-size:12px;border-collapse:collapse">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ddd">' +
      '<th>Period</th><th>Source</th><th style="text-align:right">Share growth</th><th style="text-align:right">Founder Δ</th><th style="text-align:right">Preferred Δ</th><th style="text-align:right">Post-money</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderProjection(p) {
    if (!p) return "";
    return '<div style="margin-top:12px;padding:8px;background:#f0f4ff;border-left:3px solid #3a72b5;font-size:12px">' +
      '<strong>Trajectory projection (' + esc(p.projected_as_of) + ')</strong> — basis: ' + p.basis_steps + ' step(s). ' +
      'Projected post-money: ' + esc(fmtUsd(p.projected_post_money_usd)) + '; ' +
      'projected founder %: ' + esc(fmtPct(p.projected_founder_pct)) + '.' +
      '</div>';
  }

  async function mount(opts) {
    var root = document.getElementById(opts.rootId);
    if (!root) return;
    root.innerHTML = '<div class="ads-loading" style="font-size:12px">Loading cap table…</div>';
    try {
      var snap = await api("/api/companies/" + encodeURIComponent(opts.entityId) + "/cap-table");
      if (!snap.best) {
        root.innerHTML = '<div class="ads-muted" style="font-size:12px">No cap-table evidence found yet. Sources: S-1, Delaware COI, Form D, secondary listings, press releases.</div>';
        return;
      }
      var dil = await api("/api/companies/" + encodeURIComponent(opts.entityId) + "/cap-table/dilution").catch(function () { return { steps: [] }; });
      root.innerHTML =
        renderConfidenceBanner(snap.best) +
        renderSummary(snap.best) +
        '<div data-holders-region>' + renderHoldersTable(snap.best.holders, "holders-region") + '</div>' +
        renderDilution(dil.steps) +
        (dil.projection ? renderProjection(dil.projection) : "");
      bindSortHandlers(root, snap.best);
    } catch (e) {
      root.innerHTML = '<div class="ads-muted" style="font-size:12px">Cap table unavailable: ' + esc(e.message) + '</div>';
    }
  }

  window.ADS.CapTable = { mount: mount };
})();
