// Firms search page (Task #20).
// Filter form -> querystring -> /api/firms (list), /api/firms/aggregate
// (summary strip), /api/saved-filters (sidebar).
(function () {
  if (!document.getElementById("ads-firms-filters")) return;

  var API_BASE = (window.ADS && window.ADS.apiBase) || "https://api.aidatasignal.com";

  var DEFAULT_COLS = ["name", "kind", "hq", "stages", "sectors", "check_size_typical_usd", "aum_usd", "lead_or_co", "portfolio_count", "last_modified"];
  var ALL_COLS = DEFAULT_COLS.concat(["website", "founded_year", "team_size", "unicorns_count", "exits_count", "contact_email", "status", "quality_score"]);

  var state = {
    cols: load("ads_firms_cols", DEFAULT_COLS),
    nextCursor: null,
    items: [],
  };

  function load(k, fb) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (_) { return fb; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtMoney(n) { if (!n) return "—"; if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k"; return "$" + n; }
  function fmtArr(j) { try { var a = JSON.parse(j); return Array.isArray(a) ? a.join(", ") : ""; } catch (_) { return ""; } }
  function fmtDate(d) { return d ? String(d).slice(0, 10) : ""; }

  function buildQS(form) {
    var fd = new FormData(form);
    var p = new URLSearchParams();
    fd.forEach(function (v, k) {
      v = String(v).trim(); if (!v) return;
      p.append(k, v);
    });
    return p;
  }

  function readQS() {
    var p = new URLSearchParams(window.location.search);
    var form = document.getElementById("ads-firms-filters");
    p.forEach(function (v, k) {
      var el = form.elements[k]; if (!el) return;
      if (el.type === "checkbox") el.checked = (v === "1" || v === "true");
      else el.value = v;
    });
  }

  function syncURL(p) {
    var qs = p.toString();
    var url = window.location.pathname + (qs ? "?" + qs : "");
    window.history.replaceState({}, "", url);
  }

  function rowFor(f, col) {
    switch (col) {
      case "name": return '<a href="/dashboard/firm-detail/?id=' + f.id + '">' + esc(f.name) + '</a>';
      case "kind": return esc(f.kind || "");
      case "hq": return esc([f.hq_city, f.hq_country_iso2].filter(Boolean).join(", "));
      case "stages": return esc(fmtArr(f.stages_json));
      case "sectors": return esc(fmtArr(f.sectors_json));
      case "check_size_typical_usd": return fmtMoney(f.check_size_typical_usd);
      case "aum_usd": return fmtMoney(f.aum_usd);
      case "lead_or_co": return esc(f.lead_or_co || "");
      case "portfolio_count": return f.portfolio_count != null ? f.portfolio_count : "";
      case "last_modified": return fmtDate(f.last_modified);
      case "website": return f.website ? '<a href="' + esc(f.website) + '" target="_blank" rel="noopener">' + esc(f.website.replace(/^https?:\/\//, "")) + '</a>' : "";
      case "founded_year": return f.founded_year || "";
      case "team_size": return f.team_size || "";
      case "unicorns_count": return f.unicorns_count || 0;
      case "exits_count": return f.exits_count || 0;
      case "contact_email": return esc(f.contact_email || "");
      case "status": return esc(f.status || "");
      case "quality_score": return f.quality_score != null ? Number(f.quality_score).toFixed(2) : "";
    }
    return esc(String(f[col] == null ? "" : f[col]));
  }

  function renderTable() {
    var thead = document.getElementById("ads-firms-thead");
    thead.innerHTML = state.cols.map(function (c) {
      return '<th style="text-align:left;padding:6px;border-bottom:1px solid #eee;font-size:12px;text-transform:uppercase;color:#667">' + esc(c) + '</th>';
    }).join("");
    var tbody = document.getElementById("ads-firms-tbody");
    if (!state.items.length) { tbody.innerHTML = '<tr><td colspan="' + state.cols.length + '" class="ads-muted" style="padding:12px">No matches.</td></tr>'; return; }
    tbody.innerHTML = state.items.map(function (f) {
      return '<tr style="cursor:pointer" data-id="' + f.id + '">' + state.cols.map(function (c) {
        return '<td style="padding:6px;border-bottom:1px solid #f4f4f4;font-size:13px">' + rowFor(f, c) + '</td>';
      }).join("") + '</tr>';
    }).join("");
    tbody.querySelectorAll("tr").forEach(function (tr) {
      tr.addEventListener("click", function (e) {
        if (e.target && e.target.tagName === "A") return;
        window.location.href = "/dashboard/firm-detail/?id=" + tr.dataset.id;
      });
    });
    document.getElementById("ads-firms-shown").textContent = state.items.length + " row" + (state.items.length === 1 ? "" : "s");
    var more = document.getElementById("ads-firms-loadmore");
    more.hidden = !state.nextCursor;
  }

  function api(path) {
    return fetch(API_BASE + path, { credentials: "include" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function loadResults(append) {
    var p = buildQS(document.getElementById("ads-firms-filters"));
    syncURL(p);
    if (append && state.nextCursor) p.set("cursor", String(state.nextCursor));
    return api("/api/firms?" + p.toString()).then(function (data) {
      state.nextCursor = data.nextCursor || null;
      state.items = append ? state.items.concat(data.items || []) : (data.items || []);
      renderTable();
    }).catch(function () {
      document.getElementById("ads-firms-tbody").innerHTML = '<tr><td colspan="' + state.cols.length + '" class="ads-muted" style="padding:12px">Failed to load.</td></tr>';
    });
  }

  function loadSummary() {
    var p = buildQS(document.getElementById("ads-firms-filters"));
    return api("/api/firms/aggregate?" + p.toString()).then(function (s) {
      var card = document.getElementById("ads-firms-summary");
      card.querySelector('[data-k="count"]').textContent = (s.count || 0).toLocaleString();
      card.querySelector('[data-k="aum"]').textContent = fmtMoney(s.total_aum_usd);
      card.querySelector('[data-k="median"]').textContent = fmtMoney(s.median_check_size_usd);
      card.querySelector('[data-k="sectors"]').innerHTML = (s.top_sectors || []).map(function (x) { return esc(x.slug) + " (" + x.count + ")"; }).join("<br>") || "—";
      card.querySelector('[data-k="cities"]').innerHTML = (s.top_cities || []).map(function (x) { return esc(x.k) + " (" + x.n + ")"; }).join("<br>") || "—";
    }).catch(function () { /* non-critical */ });
  }

  function loadViews() {
    var ul = document.getElementById("ads-firms-views-list");
    return api("/api/saved-filters?entity=firms").then(function (data) {
      var items = (data && data.items) || [];
      if (!items.length) { ul.innerHTML = '<li class="ads-muted">No saved views yet.</li>'; return; }
      ul.innerHTML = items.map(function (v) {
        return '<li style="margin:4px 0;display:flex;justify-content:space-between;align-items:center"><a href="?' + esc(v.querystring) + '" data-qs="' + esc(v.querystring) + '">' + esc(v.name) + '</a><button class="ads-view-del" data-id="' + v.id + '" style="background:none;border:none;color:#a00;cursor:pointer">&times;</button></li>';
      }).join("");
      ul.querySelectorAll(".ads-view-del").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.preventDefault();
          if (!confirm("Delete this view?")) return;
          fetch(API_BASE + "/api/saved-filters/" + b.dataset.id, { method: "DELETE", credentials: "include" }).then(loadViews);
        });
      });
    }).catch(function () { ul.innerHTML = '<li class="ads-muted">Failed to load.</li>'; });
  }

  function setupColumnsModal() {
    var modal = document.getElementById("ads-firms-cols-modal");
    document.getElementById("ads-firms-columns").addEventListener("click", function () {
      var list = document.getElementById("ads-firms-cols-list");
      list.innerHTML = ALL_COLS.map(function (c) {
        var checked = state.cols.indexOf(c) !== -1 ? "checked" : "";
        return '<label><input type="checkbox" data-col="' + c + '" ' + checked + '> ' + esc(c) + '</label>';
      }).join("");
      list.querySelectorAll("input").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var col = cb.dataset.col;
          if (cb.checked) { if (state.cols.indexOf(col) === -1) state.cols.push(col); }
          else state.cols = state.cols.filter(function (x) { return x !== col; });
          save("ads_firms_cols", state.cols);
          renderTable();
        });
      });
      modal.hidden = false;
    });
    document.getElementById("ads-firms-cols-close").addEventListener("click", function () { modal.hidden = true; });
    modal.addEventListener("click", function (e) { if (e.target === modal) modal.hidden = true; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    readQS();
    setupColumnsModal();
    document.getElementById("ads-firms-filters").addEventListener("submit", function (e) {
      e.preventDefault();
      state.nextCursor = null;
      loadResults(false); loadSummary();
    });
    document.getElementById("ads-firms-reset").addEventListener("click", function () {
      var f = document.getElementById("ads-firms-filters"); f.reset();
      state.nextCursor = null;
      syncURL(new URLSearchParams());
      loadResults(false); loadSummary();
    });
    document.getElementById("ads-firms-loadmore").addEventListener("click", function () { loadResults(true); });
    document.getElementById("ads-firms-save-view").addEventListener("click", function () {
      var name = prompt("Name this view:"); if (!name) return;
      var qs = buildQS(document.getElementById("ads-firms-filters")).toString();
      fetch(API_BASE + "/api/saved-filters", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, entity: "firms", querystring: qs }),
      }).then(loadViews);
    });
    document.getElementById("ads-firms-export").addEventListener("click", function () {
      // Defer to Task #19's export modal: pre-populate via window.adsExport hook
      // when present, otherwise fall back to opening the dashboard's modal.
      var qs = buildQS(document.getElementById("ads-firms-filters"));
      var filter = {};
      qs.forEach(function (v, k) { filter[k] = v; });
      if (window.adsExport && typeof window.adsExport.openCustom === "function") {
        window.adsExport.openCustom({ entity: "firms", filter: filter });
        return;
      }
      // Fallback: post directly with the firm-default columns and download CSV.
      fetch(API_BASE + "/api/exports/csv", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "firms",
          columns: state.cols.filter(function (c) { return c !== "hq"; }).map(function (c) { return { field: c }; }),
          filter: filter, format: "csv",
        }),
      }).then(function (r) { return r.blob(); }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a"); a.href = url; a.download = "firms.csv";
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
      });
    });

    loadViews(); loadResults(false); loadSummary();
  });
})();
