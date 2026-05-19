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
  var API = (window.ADS_API_BASE || "https://api.aidatasignal.com").replace(/\/+$/, "");

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

  function renderHoldersTable(holders) {
    if (!holders || !holders.length) return '<div class="ads-muted" style="font-size:12px">No holders disclosed at this confidence tier.</div>';
    var rows = holders.map(function (h) {
      return '<tr>' +
        '<td>' + esc(h.holder_name) + (h.holder_entity_id ? ' <a href="/dashboard/profile/?entity=' + encodeURIComponent(h.holder_entity_id) + '" style="font-size:10px">↗</a>' : '') + '</td>' +
        '<td style="font-size:11px;color:#666">' + esc(h.holder_class) + '</td>' +
        '<td style="font-size:11px;color:#666">' + esc(h.security_type || "—") + '</td>' +
        '<td style="text-align:right">' + fmtShares(h.shares) + '</td>' +
        '<td style="text-align:right">' + fmtPct(h.pct_ownership) + '</td>' +
        '<td style="text-align:right">' + fmtUsd(h.original_investment_usd) + '</td>' +
        '<td style="font-size:11px">' + esc(h.round_acquired || "—") + '</td>' +
      '</tr>';
    }).join("");
    return '<table class="ads-table" style="width:100%;font-size:12px;border-collapse:collapse">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ddd">' +
      '<th>Holder</th><th>Class</th><th>Security</th><th style="text-align:right">Shares</th><th style="text-align:right">%</th><th style="text-align:right">Investment</th><th>Round</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
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
        renderHoldersTable(snap.best.holders) +
        renderDilution(dil.steps);
    } catch (e) {
      root.innerHTML = '<div class="ads-muted" style="font-size:12px">Cap table unavailable: ' + esc(e.message) + '</div>';
    }
  }

  window.ADS.CapTable = { mount: mount };
})();
