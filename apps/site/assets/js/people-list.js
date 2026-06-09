// Task #2 (People): list-mode JS for /dashboard/people/.
// Renders one row per person from GET /api/people, with cross-list
// role badges (each chip linking to its respective list). Skipped
// when ?id= is present (dossier mode owns the page in that case).
(function () {
  if (!document.getElementById("ads-people-list-root")) return;
  if (document.getElementById("ads-people-list-root").hidden) return;

  var API = window.adsApiBase;
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function api(path, opts) {
    var fn = window.adsApiFetch || function (p, o) {
      return fetch(API + p, Object.assign({ credentials: "include" }, o || {})).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    };
    return fn(path, opts);
  }

  // Role → list URL (cross-list badges). Roles without a route in
  // this app render as a non-link chip per the spec constraint
  // ("Cross-list badges link to existing routes only").
  var ROLE_LIST_URL = {
    investor: "/dashboard/investors/",
    customer: "/dashboard/accounts/",
    prospect: "/dashboard/accounts/?role=prospect",
    founder: "/dashboard/people/?role=founder",
    operator: "/dashboard/people/?role=operator",
    lead: "/dashboard/leads/",
  };

  function roleChip(role) {
    var url = ROLE_LIST_URL[role];
    var cls = "ads-pill ads-pill--role";
    if (url) {
      return '<a class="' + cls + '" href="' + url + '" data-role="' + esc(role) + '">' + esc(role) + '</a>';
    }
    return '<span class="' + cls + '" data-role="' + esc(role) + '">' + esc(role) + '</span>';
  }

  function rolesBadges(roles) {
    if (!roles || !roles.length) return '<span class="ads-muted" style="font-size:11px">unclassified</span>';
    return roles.map(roleChip).join(" ");
  }

  function avatarInitial(name, email) {
    var s = (name || email || "?").trim();
    return s.charAt(0).toUpperCase() || "?";
  }

  var state = { offset: 0, lastQs: "", sort_by: "", sort_dir: "desc" };

  function buildQs(extra) {
    var form = document.getElementById("ads-people-filters");
    var fd = new FormData(form);
    var qs = new URLSearchParams();
    fd.forEach(function (v, k) {
      var s = String(v == null ? "" : v).trim();
      if (s) qs.set(k, s);
    });
    qs.set("limit", "50");
    if (state.sort_by) { qs.set("sort_by", state.sort_by); qs.set("sort_dir", state.sort_dir); }
    if (extra) Object.keys(extra).forEach(function (k) { qs.set(k, extra[k]); });
    return qs.toString();
  }

  // Click-to-sort: server-side ordering via sort_by/sort_dir. The header is
  // re-rendered on every full (non-append) render, so wiring + indicators
  // run right after innerHTML is set.
  function indicator(key) {
    return state.sort_by === key ? (state.sort_dir === "asc" ? " ▲" : " ▼") : "";
  }
  function wireSortHeaders() {
    var listEl = document.getElementById("ads-people-list");
    if (!listEl) return;
    listEl.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.style.cursor = "pointer";
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-sort");
        if (state.sort_by === key) state.sort_dir = state.sort_dir === "asc" ? "desc" : "asc";
        else { state.sort_by = key; state.sort_dir = "asc"; }
        state.offset = 0;
        load(false);
      });
    });
  }

  function renderRows(items, append) {
    var listEl = document.getElementById("ads-people-list");
    if (!items || items.length === 0) {
      if (!append) listEl.innerHTML = '<div class="ads-empty">No people match these filters.</div>';
      return;
    }
    var html = "";
    if (!append) {
      html += '<div class="ads-table-wrap"><table class="ads-table" style="width:100%;border-collapse:collapse"><thead><tr>'
        + '<th style="text-align:left;padding:8px;width:40px"></th>'
        + '<th style="text-align:left;padding:8px" data-sort="name">Name' + indicator("name") + '</th>'
        + '<th style="text-align:left;padding:8px">Roles</th>'
        + '<th style="text-align:left;padding:8px" data-sort="domain">Domain' + indicator("domain") + '</th>'
        + '<th style="text-align:left;padding:8px" data-sort="email">Email' + indicator("email") + '</th>'
        + '<th style="text-align:right;padding:8px" data-sort="created">Created' + indicator("created") + '</th>'
        + '</tr></thead><tbody id="ads-people-tbody">';
    }
    items.forEach(function (p) {
      var href = "/dashboard/people/?id=" + encodeURIComponent(p.id);
      var name = p.display_name || p.primary_email_key || "(no name)";
      var created = (p.created_at || "").slice(0, 10);
      html += '<tr data-id="' + esc(p.id) + '">'
        + '<td style="padding:8px;vertical-align:middle">'
        + '<span class="ads-avatar-sm" aria-hidden="true" style="display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border-radius:50%;background:var(--ads-bg-2);font-weight:600;font-size:12px">' + esc(avatarInitial(p.display_name, p.primary_email_key)) + '</span>'
        + '</td>'
        + '<td style="padding:8px"><a href="' + href + '">' + esc(name) + '</a></td>'
        + '<td style="padding:8px" class="ads-people-roles">' + rolesBadges(p.roles) + '</td>'
        + '<td style="padding:8px">' + esc(p.primary_domain || "—") + '</td>'
        + '<td style="padding:8px">' + esc(p.primary_email_key || "—") + '</td>'
        + '<td style="padding:8px;text-align:right">' + esc(created || "—") + '</td>'
        + '</tr>';
    });
    if (!append) {
      html += '</tbody></table></div>';
      listEl.innerHTML = html;
      wireSortHeaders();
    } else {
      var tbody = document.getElementById("ads-people-tbody");
      if (tbody) tbody.insertAdjacentHTML("beforeend", html);
    }
  }

  function load(append) {
    var qs = buildQs();
    if (append) qs += "&offset=" + state.offset;
    else state.offset = 0;
    state.lastQs = qs;
    var msg = document.getElementById("ads-people-msg");
    if (msg) msg.textContent = append ? "Loading more…" : "Loading…";
    api("/api/people?" + qs).then(function (data) {
      renderRows(data.items, append);
      var moreBtn = document.getElementById("ads-people-more");
      if (data.next_offset != null) {
        state.offset = data.next_offset;
        moreBtn.hidden = false;
      } else {
        moreBtn.hidden = true;
      }
      if (msg) msg.textContent = "";
    }).catch(function (e) {
      if (msg) msg.textContent = "Load failed: " + e.message;
    });
  }

  // Expose for tests
  window.__adsPeopleListRender = renderRows;
  window.__adsPeopleListRoleChip = roleChip;

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("ads-people-filters");
    if (!form) return;
    form.addEventListener("submit", function (e) { e.preventDefault(); load(false); });
    form.addEventListener("reset", function () { setTimeout(function () { load(false); }, 0); });
    var moreBtn = document.getElementById("ads-people-more");
    if (moreBtn) moreBtn.addEventListener("click", function () { load(true); });
    load(false);
  });
})();
