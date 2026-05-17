// Task #2 — Leads browse + bulk-bar wiring.
(function () {
  var API = window.adsApiBase || "https://api.aidatasignal.com";
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function api(path, opts) {
    var fn = window.adsApiFetch || function (p, o) {
      return fetch(API + p, Object.assign({ credentials: "include" }, o || {})).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
      });
    };
    return fn(path, opts);
  }

  var state = { items: [], limit: 200, lastQs: "" };

  function buildQs(extra) {
    var form = document.getElementById("ads-leads-filters");
    var fd = new FormData(form);
    var qs = new URLSearchParams();
    fd.forEach(function (v, k) { if (v !== "" && v != null) qs.set(k, v); });
    qs.set("limit", String(state.limit));
    if (extra) Object.keys(extra).forEach(function (k) { qs.set(k, extra[k]); });
    return qs.toString();
  }

  function render(items) {
    var tbody = document.getElementById("ads-leads-tbody");
    if (!items.length) {
      tbody.innerHTML = '<tr><td class="ads-muted" colspan="7">No leads match the filters.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (l) {
      return '<tr>'
        + '<td style="padding:8px;vertical-align:middle"><input type="checkbox" class="ads-bulk-check" data-id="' + esc(l.id) + '"></td>'
        + '<td style="padding:8px"><a href="/dashboard/people/?id=' + esc(l.id) + '">' + esc(l.name || "(no name)") + '</a></td>'
        + '<td style="padding:8px">' + esc(l.org || "—") + '</td>'
        + '<td style="padding:8px">' + esc(l.email || "—") + '</td>'
        + '<td style="padding:8px">' + esc(l.status || "—") + '</td>'
        + '<td style="padding:8px">' + esc(l.country_iso2 || "—") + '</td>'
        + '<td style="padding:8px;text-align:right">' + esc((l.updated_at || "").slice(0, 10)) + '</td>'
        + '</tr>';
    }).join("");
  }

  function load() {
    var qs = buildQs();
    state.lastQs = qs;
    api("/api/leads?" + qs).then(function (r) {
      state.items = r.items || [];
      render(state.items);
      if (window.adsBulkBar) {
        window.adsBulkBar.onFilterChange();
        window.adsBulkBar.rebind();
      }
    }).catch(function (e) {
      document.getElementById("ads-leads-tbody").innerHTML =
        '<tr><td class="ads-muted" colspan="7">Load failed: ' + esc(e.message) + '</td></tr>';
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("ads-leads-filters");
    form.addEventListener("submit", function (e) { e.preventDefault(); load(); });
    form.addEventListener("reset", function () { setTimeout(load, 0); });

    if (window.adsBulkBar) {
      window.adsBulkBar.init({
        pageId: "leads",
        getVisibleIds: function () { return state.items.map(function (l) { return l.id; }); },
        getAllMatchingIds: function () {
          // /api/leads server-caps at 200 with no offset; loop with
          // status filter only would re-fetch the same page. Use the
          // currently loaded items as the "all matching" set since
          // there is no pagination cursor on this endpoint today.
          return Promise.resolve(state.items.map(function (l) { return l.id; }));
        },
        filterSignature: function () { return state.lastQs; },
      });
    }
    load();
  });
})();
