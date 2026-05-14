(function () {
  var API_BASE = "https://api.aidatasignal.com";

  function fmtPct(n) {
    if (n == null) return "—";
    return (Math.round(n * 1000) / 10) + "%";
  }
  function fmtInt(n) {
    if (n == null) return "—";
    return new Intl.NumberFormat("en-US").format(n);
  }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function elapsed(iso) {
    if (!iso) return "—";
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 0 || isNaN(ms)) return "—";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
    return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  }

  // apiFetch: shared helper. credentials:include so the Cloudflare Access JWT
  // cookie rides along on every request from the dashboard.
  async function apiFetch(path, opts) {
    var res = await fetch(API_BASE + path, Object.assign({ credentials: "include" }, opts || {}));
    if (!res.ok) {
      var msg = "HTTP " + res.status;
      try { var j = await res.json(); if (j && j.message) msg = j.message; } catch (e) {}
      throw new Error(msg);
    }
    var ct = res.headers.get("content-type") || "";
    return ct.indexOf("application/json") >= 0 ? res.json() : res.text();
  }
  async function api(path) {
    try { return await apiFetch(path); } catch (e) { console.warn("API call failed", path, e); return null; }
  }
  // Expose for other dashboard scripts (jobs.js, review.js future migration).
  window.adsApiFetch = apiFetch;
  window.adsApiBase = API_BASE;

  function setKpi(key, val) {
    var el = document.querySelector('[data-kpi="' + key + '"]');
    if (el) el.textContent = val;
  }
  function renderEmpty(container, msg) {
    if (container) container.innerHTML = '<div class="ads-empty">' + esc(msg) + "</div>";
  }

  function renderRecentLeads(items) {
    var c = document.getElementById("ads-recent-leads");
    if (!c) return;
    if (!items || !items.length) return renderEmpty(c, "No leads yet.");
    var html = '<table class="ads-table"><thead><tr><th>Name</th><th>Org</th><th>Source</th><th>Status</th></tr></thead><tbody>';
    items.forEach(function (l) {
      var pillCls = l.status === "approved" ? "ok" : l.status === "pending" ? "warn" : l.status === "flagged" ? "err" : "idle";
      html += "<tr><td>" + esc(l.name || "—") + "</td><td>" + esc(l.org || "—") + "</td><td>" + esc(l.source_domain || "—") + '</td><td><span class="ads-pill ' + pillCls + '">' + esc(l.status || "new") + "</span></td></tr>";
    });
    html += "</tbody></table>";
    c.innerHTML = html;
  }

  function renderTopSources(items) {
    var c = document.getElementById("ads-top-sources");
    if (!c) return;
    if (!items || !items.length) return renderEmpty(c, "No source data yet.");
    var html = '<table class="ads-table"><thead><tr><th>Domain</th><th>Leads</th></tr></thead><tbody>';
    items.forEach(function (s) {
      html += "<tr><td>" + esc(s.domain) + "</td><td>" + fmtInt(s.lead_count) + "</td></tr>";
    });
    html += "</tbody></table>";
    c.innerHTML = html;
  }

  function renderRecentJobs(items) {
    var c = document.getElementById("ads-recent-jobs");
    if (!c) return;
    if (!items || !items.length) return renderEmpty(c, "No jobs yet.");
    var html = '<table class="ads-table"><thead><tr><th>Job</th><th>Source</th><th>Status</th><th>Started</th></tr></thead><tbody>';
    items.forEach(function (j) {
      var pillCls = j.status === "completed" ? "ok" : j.status === "running" ? "warn" : j.status === "failed" ? "err" : "idle";
      html += "<tr><td>" + esc(j.name || j.id) + "</td><td>" + esc(j.source || "—") + '</td><td><span class="ads-pill ' + pillCls + '">' + esc(j.status || "queued") + "</span></td><td>" + (j.started_at ? esc(new Date(j.started_at).toLocaleString()) : "—") + "</td></tr>";
    });
    html += "</tbody></table>";
    c.innerHTML = html;
  }

  function renderCategories(items) {
    var c = document.getElementById("ads-leads-by-category");
    if (!c) return;
    if (!items || !items.length) return renderEmpty(c, "No categories yet.");
    var html = '<table class="ads-table"><thead><tr><th>Category</th><th>Leads</th></tr></thead><tbody>';
    items.forEach(function (cat) {
      html += "<tr><td>" + esc(cat.category) + "</td><td>" + fmtInt(cat.count) + "</td></tr>";
    });
    html += "</tbody></table>";
    c.innerHTML = html;
  }

  // ---------------- Active jobs strip ----------------
  // Polls /api/jobs?status=queued,running every 3s. The strip is only rendered
  // on pages that include the #ads-active-jobs container (the dashboard home).
  var activeTimer = null;
  function renderActiveJobs(items) {
    var c = document.getElementById("ads-active-jobs");
    if (!c) return;
    if (!items || !items.length) {
      c.innerHTML = '<div class="ads-empty">No active jobs.</div>';
      return;
    }
    var html = '<table class="ads-table ads-table--active"><thead><tr><th>Job</th><th>Kind</th><th>Status</th><th>Pages</th><th>Leads</th><th>Elapsed</th><th></th></tr></thead><tbody>';
    items.forEach(function (j) {
      var pillCls = j.status === "running" ? "warn" : "idle";
      html +=
        '<tr data-id="' + esc(j.id) + '">' +
        '<td>' + esc(j.name || j.id) + '</td>' +
        '<td>' + esc(j.kind || "—") + '</td>' +
        '<td><span class="ads-pill ' + pillCls + '">' + esc(j.status) + '</span></td>' +
        '<td>' + fmtInt(j.pages_fetched || 0) + '</td>' +
        '<td>' + fmtInt(j.leads_found || 0) + '</td>' +
        '<td>' + esc(elapsed(j.started_at)) + '</td>' +
        '<td><button class="ads-btn ads-btn--ghost ads-btn--sm" data-cancel-job="' + esc(j.id) + '">Cancel</button></td>' +
        '</tr>';
    });
    html += "</tbody></table>";
    c.innerHTML = html;
  }
  async function pollActiveJobs() {
    var data = await api("/api/jobs?status=queued,running&limit=50");
    renderActiveJobs(data && data.items);
  }
  function startActiveJobsPolling() {
    if (!document.getElementById("ads-active-jobs")) return;
    pollActiveJobs();
    activeTimer = setInterval(pollActiveJobs, 3000);
  }

  // ---------------- Start Scrape panel ----------------
  function showMsg(form, text, kind) {
    var el = form.querySelector("[data-msg]");
    if (!el) return;
    el.textContent = text || "";
    el.className = "ads-form-msg" + (kind ? " ads-form-msg--" + kind : "");
  }
  function setupTabs() {
    var tabs = document.querySelectorAll("#ads-scrape-panel .ads-tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        var name = t.getAttribute("data-tab");
        document.querySelectorAll("#ads-scrape-panel .ads-tab").forEach(function (x) { x.classList.toggle("active", x === t); });
        document.querySelectorAll("#ads-scrape-panel .ads-tab-panel").forEach(function (p) { p.classList.toggle("active", p.getAttribute("data-tab") === name); });
      });
    });
  }
  async function postJob(payload) {
    return apiFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  function setupSingleForm() {
    var f = document.getElementById("ads-form-single");
    if (!f) return;
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = f.querySelector("button[type=submit]");
      btn.disabled = true; showMsg(f, "Queuing…");
      var fd = new FormData(f);
      var target = String(fd.get("target") || "").trim();
      var name = String(fd.get("name") || "").trim();
      try {
        await postJob({ kind: "url", target: target, name: name || undefined });
        showMsg(f, "Queued.", "ok");
        f.reset();
        pollActiveJobs();
      } catch (err) {
        showMsg(f, "Failed: " + err.message, "err");
      } finally {
        btn.disabled = false;
      }
    });
  }
  function setupLinktreeForm() {
    var f = document.getElementById("ads-form-linktree");
    if (!f) return;
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = f.querySelector("button[type=submit]");
      btn.disabled = true; showMsg(f, "Queuing…");
      var fd = new FormData(f);
      var target = String(fd.get("target") || "").trim();
      var parser = String(fd.get("parser") || "").trim();
      var config = parser ? { parser: parser } : {};
      try {
        await postJob({ kind: "linktree", target: target, config: config });
        showMsg(f, "Queued.", "ok");
        f.reset();
        pollActiveJobs();
      } catch (err) {
        showMsg(f, "Failed: " + err.message, "err");
      } finally {
        btn.disabled = false;
      }
    });
  }
  function setupBulkForm() {
    var f = document.getElementById("ads-form-bulk");
    if (!f) return;
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = f.querySelector("button[type=submit]");
      btn.disabled = true; showMsg(f, "Queuing…");
      var raw = String(new FormData(f).get("targets") || "");
      // Split on newlines; trim; dedupe; cap at 100 to protect the queue.
      var seen = {};
      var lines = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) {
        if (!s) return false;
        if (seen[s]) return false;
        seen[s] = true;
        return true;
      }).slice(0, 100);
      var queued = 0, rejected = 0, errors = [];
      for (var i = 0; i < lines.length; i++) {
        var url = lines[i];
        // Client-side URL validation; rejected lines are reported back so the
        // operator knows exactly which inputs were bad.
        try { new URL(url); } catch (err) { rejected += 1; errors.push(url); continue; }
        try {
          await postJob({ kind: "url", target: url });
          queued += 1;
        } catch (err) {
          rejected += 1;
          errors.push(url + " (" + err.message + ")");
        }
      }
      var summary = "Queued " + queued + " · rejected " + rejected;
      if (errors.length) summary += " · first reject: " + errors[0];
      showMsg(f, summary, rejected ? "warn" : "ok");
      if (queued > 0) { f.reset(); pollActiveJobs(); }
      btn.disabled = false;
    });
  }

  // Cancel button delegate (works for any active-jobs strip on the page).
  document.addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-cancel-job]");
    if (!btn) return;
    var id = btn.getAttribute("data-cancel-job");
    btn.disabled = true; btn.textContent = "Cancelling…";
    try {
      await apiFetch("/api/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
      pollActiveJobs();
    } catch (err) {
      btn.disabled = false; btn.textContent = "Cancel";
      console.warn("cancel failed", err);
    }
  });

  async function loadIdentity() {
    var me = await api("/api/auth/me");
    var el = document.getElementById("ads-user-email");
    if (el) el.textContent = me && me.email ? me.email : "(not signed in)";
  }

  async function loadDashboard() {
    if (!document.getElementById("ads-kpi-grid")) return;
    var summary = await api("/api/analytics/summary");
    if (summary) {
      setKpi("total_leads", fmtInt(summary.total_leads));
      setKpi("verified_leads", fmtInt(summary.verified_leads));
      setKpi("approved_leads", fmtInt(summary.approved_leads));
      setKpi("pending_leads", fmtInt(summary.pending_leads));
      setKpi("active_jobs", fmtInt(summary.active_jobs));
      setKpi("exports_count", fmtInt(summary.exports_count));
      setKpi("verification_rate", fmtPct(summary.verification_rate));
      setKpi("job_success_rate", fmtPct(summary.job_success_rate));
      renderRecentLeads(summary.recent_leads);
      renderRecentJobs(summary.recent_jobs);
      renderCategories(summary.leads_by_category);
    } else {
      ["total_leads","verified_leads","approved_leads","pending_leads","active_jobs","exports_count","verification_rate","job_success_rate"].forEach(function (k) { setKpi(k, "—"); });
      renderEmpty(document.getElementById("ads-recent-leads"), "API unavailable.");
      renderEmpty(document.getElementById("ads-recent-jobs"), "API unavailable.");
      renderEmpty(document.getElementById("ads-leads-by-category"), "API unavailable.");
    }
    var sources = await api("/api/analytics/sources");
    renderTopSources(sources && sources.items);
  }

  document.addEventListener("DOMContentLoaded", function () {
    loadIdentity();
    loadDashboard();
    setupTabs();
    setupSingleForm();
    setupLinktreeForm();
    setupBulkForm();
    startActiveJobsPolling();
    var btn = document.getElementById("ads-export-btn");
    if (btn) btn.addEventListener("click", function () { window.location.href = API_BASE + "/api/exports/csv"; });
  });

  // Pause polling when the tab is hidden to save quota.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }
    } else if (!activeTimer && document.getElementById("ads-active-jobs")) {
      startActiveJobsPolling();
    }
  });
})();
