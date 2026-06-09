// Task #2 — Leads browse + bulk-bar wiring.
(function () {
  var API = window.adsApiBase;
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
  var bar = null;

  function buildQs(extra) {
    var form = document.getElementById("ads-leads-filters");
    var fd = new FormData(form);
    var qs = new URLSearchParams();
    fd.forEach(function (v, k) { if (v !== "" && v != null) qs.set(k, v); });
    qs.set("limit", String(state.limit));
    if (extra) Object.keys(extra).forEach(function (k) { qs.set(k, extra[k]); });
    return qs.toString();
  }

  // Task #2: cross-list role badges. Roles arrive on each lead row
  // from the listing API (entity_legacy_map → entity_roles join).
  var ROLE_LIST_URL = {
    investor: "/dashboard/investors/",
    customer: "/dashboard/accounts/",
    prospect: "/dashboard/accounts/?role=prospect",
    founder: "/dashboard/people/?role=founder",
    operator: "/dashboard/people/?role=operator",
    lead: "/dashboard/leads/",
  };
  function rolesBadges(roles) {
    if (!roles || !roles.length) return "";
    return roles.map(function (role) {
      var url = ROLE_LIST_URL[role];
      if (url) return '<a class="ads-pill ads-pill--role" href="' + url + '" data-role="' + esc(role) + '" style="margin-left:4px">' + esc(role) + '</a>';
      return '<span class="ads-pill ads-pill--role" data-role="' + esc(role) + '" style="margin-left:4px">' + esc(role) + '</span>';
    }).join("");
  }

  function render(items) {
    var tbody = document.getElementById("ads-leads-tbody");
    if (!items.length) {
      tbody.innerHTML = '<tr><td class="ads-muted" colspan="7">No leads match the filters.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (l) {
      return '<tr data-id="' + esc(l.id) + '">'
        + '<td style="padding:8px;vertical-align:middle"><input type="checkbox" class="ads-bulk-check" data-id="' + esc(l.id) + '"></td>'
        + '<td style="padding:8px"><a href="/dashboard/people/?id=' + esc(l.id) + '">' + esc(l.name || "(no name)") + '</a>' + rolesBadges(l.roles) + '</td>'
        + '<td style="padding:8px">' + esc(l.org || "—") + '</td>'
        + '<td style="padding:8px">' + esc(l.email || "—") + '</td>'
        + '<td style="padding:8px">' + esc(l.status || "—") + '</td>'
        + '<td style="padding:8px">' + esc(l.country_iso2 || "—") + '</td>'
        + '<td style="padding:8px;text-align:right">' + esc((l.updated_at || "").slice(0, 10)) + '</td>'
        + '</tr>';
    }).join("");
  }

  // Promote-to bulk action: collects checked rows and POSTs to
  // /api/leads/promote with the selected target role.
  function promoteSelected() {
    var checks = document.querySelectorAll("#ads-leads-tbody .ads-bulk-check:checked");
    var ids = Array.from(checks).map(function (n) { return n.getAttribute("data-id"); }).filter(Boolean);
    if (!ids.length) { alert("Select one or more leads first."); return; }
    var role = window.prompt("Promote " + ids.length + " lead(s) to which role?\n\nOptions: investor, customer, prospect, founder, operator", "investor");
    if (!role) return;
    role = role.toLowerCase().trim();
    if (["investor","customer","prospect","founder","operator"].indexOf(role) < 0) {
      alert("Unknown role: " + role);
      return;
    }
    api("/api/leads/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids, role: role, drop_lead: true }),
    }).then(function (r) {
      var target = ROLE_LIST_URL[role] || "/dashboard/people/";
      var msg = "Promoted " + (r.promoted || 0) + " lead(s) to " + role + ".";
      if (r.unresolved) msg += " " + r.unresolved + " could not be mapped to an entity.";
      msg += "\n\nOpen the " + role + " list now?";
      if (window.confirm(msg)) location.href = target;
      else load();
    }).catch(function (e) {
      alert("Promote failed: " + e.message);
    });
  }
  window.__adsLeadsPromote = promoteSelected;
  window.__adsLeadsRolesBadges = rolesBadges;

  function load() {
    var qs = buildQs();
    state.lastQs = qs;
    api("/api/leads?" + qs).then(function (r) {
      state.items = r.items || [];
      render(state.items);
      if (bar) { bar.onFilterChange(); bar.rebind(); }
    }).catch(function (e) {
      document.getElementById("ads-leads-tbody").innerHTML =
        '<tr><td class="ads-muted" colspan="7">Load failed: ' + esc(e.message) + '</td></tr>';
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("ads-leads-filters");
    form.addEventListener("submit", function (e) { e.preventDefault(); load(); });
    form.addEventListener("reset", function () { setTimeout(load, 0); });

    var promoteBtn = document.getElementById("ads-leads-promote-btn");
    if (promoteBtn) promoteBtn.addEventListener("click", promoteSelected);

    if (window.adsBulkBar && window.adsBulkBar.init) {
      bar = window.adsBulkBar.init({
        pageId: "leads",
        getRows: function () { return document.querySelectorAll("#ads-leads-tbody tr[data-id]"); },
        // /api/leads server-caps at 200 and has no offset/cursor today,
        // so "select all matching" returns the currently loaded set —
        // header-checkbox double-click thus selects all visible rows.
        fetchAllMatchingIds: function () {
          return Promise.resolve(state.items.map(function (l) { return l.id; }));
        },
        getFilterSignature: function () { return state.lastQs; },
      });
    }
    load();
  });
})();
