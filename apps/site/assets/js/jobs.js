(function () {
  var API_BASE = window.adsApiBase || "https://api.aidatasignal.com";
  // Reuse the shared apiFetch from dashboard.js so the Cloudflare Access cookie
  // and JSON error parsing are identical across pages.
  var apiFetch = window.adsApiFetch || function (path, opts) {
    return fetch(API_BASE + path, Object.assign({ credentials: "include" }, opts || {})).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  };

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmtInt(n) { if (n == null) return "—"; return new Intl.NumberFormat("en-US").format(n); }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleString() : "—"; }
  function fmtMs(n) { if (n == null) return "—"; if (n < 1000) return n + " ms"; return (n / 1000).toFixed(1) + " s"; }

  function pillClass(status) {
    return status === "completed" ? "ok"
      : status === "running" ? "warn"
      : status === "failed" ? "err"
      : status === "cancelled" ? "err"
      : "idle";
  }

  function normalizeSource(v) {
    // The API stores `source` as a bare hostname (e.g. "www.openvc.app") and
    // matches it exactly. Operators commonly paste a full URL, so coerce
    // anything URL-shaped to its lowercase hostname before sending.
    if (!v) return "";
    var s = v.trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) {
      try { return new URL(s).hostname.toLowerCase(); } catch (e) { return s.toLowerCase(); }
    }
    // Strip any leading "//" or path the user may have typed without a scheme.
    s = s.replace(/^\/\//, "").replace(/\/.*$/, "");
    return s.toLowerCase();
  }

  function buildQuery(form) {
    // Build the `?status=&kind=&source=&from=&to=` query. Empty fields are
    // skipped so the API receives only the filters the operator chose.
    var fd = new FormData(form);
    var p = new URLSearchParams();
    ["status", "kind", "source", "from", "to"].forEach(function (k) {
      var v = String(fd.get(k) || "").trim();
      if (k === "source") v = normalizeSource(v);
      if (v) p.set(k, v);
    });
    p.set("limit", "200");
    return p.toString();
  }

  function inDateRange(iso, from, to) {
    if (!from && !to) return true;
    if (!iso) return false;
    var t = new Date(iso).getTime();
    if (isNaN(t)) return false;
    if (from) {
      var ft = new Date(from + "T00:00:00").getTime();
      if (t < ft) return false;
    }
    if (to) {
      var tt = new Date(to + "T23:59:59").getTime();
      if (t > tt) return false;
    }
    return true;
  }

  function renderTable(items, from, to) {
    var c = document.getElementById("ads-jobs-table");
    if (!c) return;
    // The API does not natively filter by date range, so do it client-side
    // after fetching. The status/kind/source filters do go to the server.
    var total = (items || []).length;
    var rows = (items || []).filter(function (j) { return inDateRange(j.started_at || j.created_at, from, to); });
    // Surface the 200-row API cap so date-range filters that find nothing
    // because the matching job is older than the most-recent 200 are not
    // silently mistaken for "no jobs exist".
    var capNote = total >= 200
      ? '<div class="ads-muted" style="margin-bottom:10px;font-size:12px">Showing the most recent 200 jobs matching status/kind/source filters. Narrow status/kind/source to reach older jobs.</div>'
      : '';
    if (!rows.length) { c.innerHTML = capNote + '<div class="ads-empty">No jobs match these filters.</div>'; return; }
    var html = capNote + '<table class="ads-table ads-table--clickable"><thead><tr>' +
      '<th>Name</th><th>Kind</th><th>Source</th><th>Status</th>' +
      '<th>Pages</th><th>Blocked</th><th>Leads</th><th>Cost</th><th>Started</th><th>Finished</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (j) {
      html +=
        '<tr data-id="' + esc(j.id) + '">' +
        '<td>' + esc(j.name || j.id) + '</td>' +
        '<td>' + esc(j.kind || "—") + '</td>' +
        '<td>' + esc(j.source || "—") + '</td>' +
        '<td><span class="ads-pill ' + pillClass(j.status) + '">' + esc(j.status || "—") + '</span></td>' +
        '<td>' + fmtInt(j.pages_fetched || 0) + '</td>' +
        '<td>' + fmtInt(j.pages_blocked || 0) + '</td>' +
        '<td>' + fmtInt(j.leads_found || 0) + '</td>' +
        '<td>' + esc(fmtMs(j.cost_ms)) + '</td>' +
        '<td>' + esc(fmtTime(j.started_at)) + '</td>' +
        '<td>' + esc(fmtTime(j.finished_at || j.cancelled_at)) + '</td>' +
        '</tr>';
    });
    html += "</tbody></table>";
    c.innerHTML = html;
  }

  async function loadJobs() {
    var form = document.getElementById("ads-jobs-filters");
    var c = document.getElementById("ads-jobs-table");
    c.innerHTML = '<div class="ads-loading">Loading…</div>';
    var qs = buildQuery(form);
    var fd = new FormData(form);
    var from = String(fd.get("from") || "");
    var to = String(fd.get("to") || "");
    try {
      var data = await apiFetch("/api/jobs?" + qs);
      renderTable(data && data.items, from, to);
    } catch (e) {
      c.innerHTML = '<div class="ads-empty">Failed to load jobs: ' + esc(e.message) + '</div>';
    }
  }

  // ---------------- Detail drawer ----------------
  function prettyJson(s) {
    if (!s) return "";
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return String(s); }
  }
  function detailRow(label, value, opts) {
    opts = opts || {};
    var v = value == null || value === "" ? "—" : value;
    // Labels are hardcoded today, but escape for defense-in-depth in case a
    // future caller passes a server-derived field name.
    var lbl = esc(label);
    if (opts.code) {
      return '<div class="ads-detail__row"><div class="ads-detail__label">' + lbl + '</div><pre class="ads-detail__pre">' + esc(v) + '</pre></div>';
    }
    return '<div class="ads-detail__row"><div class="ads-detail__label">' + lbl + '</div><div class="ads-detail__value">' + esc(v) + '</div></div>';
  }
  function renderDetail(j) {
    var body = document.getElementById("ads-drawer-body");
    var title = document.getElementById("ads-drawer-title");
    if (title) title.textContent = j.name || j.id;
    var canCancel = j.status === "queued" || j.status === "running";
    var html = "";
    if (canCancel) {
      html += '<div class="ads-form-actions" style="margin-bottom:14px"><button class="ads-btn ads-btn--ghost" data-cancel-job="' + esc(j.id) + '">Cancel job</button></div>';
    }
    html += detailRow("Job ID", j.id);
    html += detailRow("Status", j.status);
    html += detailRow("Kind", j.kind);
    html += detailRow("Target", j.target);
    html += detailRow("Source", j.source);
    html += detailRow("Created", fmtTime(j.created_at));
    html += detailRow("Started", fmtTime(j.started_at));
    html += detailRow("Finished", fmtTime(j.finished_at));
    html += detailRow("Cancelled", fmtTime(j.cancelled_at));
    html += detailRow("Pages fetched", fmtInt(j.pages_fetched || 0));
    html += detailRow("Pages blocked", fmtInt(j.pages_blocked || 0));
    html += detailRow("Captcha hits", fmtInt(j.captcha_hits || 0));
    html += detailRow("Leads found", fmtInt(j.leads_found || 0));
    html += detailRow("Cost", fmtMs(j.cost_ms));
    if (j.error) html += detailRow("Error", j.error, { code: true });
    html += detailRow("config_json", prettyJson(j.config_json), { code: true });
    if (j.result_json) html += detailRow("result_json", prettyJson(j.result_json), { code: true });
    body.innerHTML = html;
  }
  async function openDrawer(id) {
    var drawer = document.getElementById("ads-job-drawer");
    var body = document.getElementById("ads-drawer-body");
    if (!drawer) return;
    drawer.hidden = false;
    document.body.classList.add("ads-no-scroll");
    body.innerHTML = '<div class="ads-loading">Loading…</div>';
    try {
      var j = await apiFetch("/api/jobs/" + encodeURIComponent(id));
      renderDetail(j);
    } catch (e) {
      body.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>';
    }
  }
  function closeDrawer() {
    var drawer = document.getElementById("ads-job-drawer");
    if (!drawer) return;
    drawer.hidden = true;
    document.body.classList.remove("ads-no-scroll");
  }

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("ads-jobs-filters");
    if (form) {
      form.addEventListener("submit", function (e) { e.preventDefault(); loadJobs(); });
      var resetBtn = document.getElementById("ads-jobs-reset");
      if (resetBtn) resetBtn.addEventListener("click", function () { form.reset(); loadJobs(); });
    }
    loadJobs();

    document.getElementById("ads-jobs-table").addEventListener("click", function (e) {
      // Ignore clicks on action buttons inside rows (none today, but future-safe).
      if (e.target.closest("button")) return;
      var tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      openDrawer(tr.getAttribute("data-id"));
    });
    var drawer = document.getElementById("ads-job-drawer");
    if (drawer) {
      drawer.addEventListener("click", function (e) {
        if (e.target.closest("[data-close]")) closeDrawer();
      });
      // After the shared cancel handler in dashboard.js posts /cancel, refresh
      // both the jobs table and the open drawer so the operator sees the
      // status flip from running -> cancelled without a manual reload.
      drawer.addEventListener("click", function (e) {
        var btn = e.target.closest("button[data-cancel-job]");
        if (!btn) return;
        var id = btn.getAttribute("data-cancel-job");
        // Defer one tick so dashboard.js completes the POST first.
        setTimeout(function () { loadJobs(); openDrawer(id); }, 400);
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });
  });
})();
