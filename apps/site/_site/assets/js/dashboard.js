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

  async function api(path) {
    try {
      var res = await fetch(API_BASE + path, { credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      console.warn("API call failed", path, e);
      return null;
    }
  }

  function setKpi(key, val) {
    var el = document.querySelector('[data-kpi="' + key + '"]');
    if (el) el.textContent = val;
  }

  function renderEmpty(container, msg) {
    container.innerHTML = '<div class="ads-empty">' + msg + "</div>";
  }

  function renderRecentLeads(items) {
    var c = document.getElementById("ads-recent-leads");
    if (!c) return;
    if (!items || !items.length) return renderEmpty(c, "No leads yet.");
    var html = '<table class="ads-table"><thead><tr><th>Name</th><th>Org</th><th>Source</th><th>Status</th></tr></thead><tbody>';
    items.forEach(function (l) {
      var pillCls = l.status === "approved" ? "ok" : l.status === "pending" ? "warn" : l.status === "flagged" ? "err" : "idle";
      html += "<tr><td>" + (l.name || "—") + "</td><td>" + (l.org || "—") + "</td><td>" + (l.source_domain || "—") + '</td><td><span class="ads-pill ' + pillCls + '">' + (l.status || "new") + "</span></td></tr>";
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
      html += "<tr><td>" + s.domain + "</td><td>" + fmtInt(s.lead_count) + "</td></tr>";
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
      html += "<tr><td>" + (j.name || j.id) + "</td><td>" + (j.source || "—") + '</td><td><span class="ads-pill ' + pillCls + '">' + (j.status || "queued") + "</span></td><td>" + (j.started_at ? new Date(j.started_at).toLocaleString() : "—") + "</td></tr>";
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
      html += "<tr><td>" + cat.category + "</td><td>" + fmtInt(cat.count) + "</td></tr>";
    });
    html += "</tbody></table>";
    c.innerHTML = html;
  }

  async function loadIdentity() {
    var me = await api("/api/auth/me");
    var el = document.getElementById("ads-user-email");
    if (el) el.textContent = me && me.email ? me.email : "(not signed in)";
  }

  async function loadDashboard() {
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
    var btn = document.getElementById("ads-export-btn");
    if (btn) btn.addEventListener("click", function () { window.location.href = API_BASE + "/api/exports/csv"; });
  });
})();
