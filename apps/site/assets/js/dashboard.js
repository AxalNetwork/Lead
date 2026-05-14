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

  // ---------------- Discover tab ----------------
  function renderCandidates(items) {
    var c = document.getElementById("ads-discover-candidates");
    if (!c) return;
    if (!items || !items.length) { c.innerHTML = '<div class="ads-empty">No pending candidates.</div>'; return; }
    var html = '<table class="ads-table"><thead><tr><th>Name / Title</th><th>Source</th><th>URL</th><th>Persona</th><th></th></tr></thead><tbody>';
    items.forEach(function (r) {
      html +=
        '<tr data-cand-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.name || r.title || "—") + '</td>' +
        '<td>' + esc(r.source) + '</td>' +
        '<td><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.url.slice(0, 60)) + '</a></td>' +
        '<td>' + esc(r.persona_role || "—") + '</td>' +
        '<td>' +
          '<button class="ads-btn ads-btn--sm" data-resolve-cand="' + esc(r.id) + '">Approve</button> ' +
          '<button class="ads-btn ads-btn--ghost ads-btn--sm" data-reject-cand="' + esc(r.id) + '">Reject</button>' +
        '</td></tr>';
    });
    html += '</tbody></table>';
    c.innerHTML = html;
  }
  async function pollCandidates(firm) {
    var qs = firm ? ('?status=pending&firmDomain=' + encodeURIComponent(firm)) : '?status=pending';
    var data = await api('/api/discover/candidates' + qs);
    renderCandidates(data && data.items);
  }
  function setupDiscoverForm() {
    var f = document.getElementById("ads-form-discover");
    if (!f) return;
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = f.querySelector("button[type=submit]");
      btn.disabled = true; showMsg(f, "Queuing…");
      var fd = new FormData(f);
      var firmDomain = String(fd.get("firmDomain") || "").trim();
      var persona = String(fd.get("persona") || "").trim();
      var country = String(fd.get("country") || "").trim();
      if (!firmDomain && !persona) { showMsg(f, "Provide a firm domain or persona.", "err"); btn.disabled = false; return; }
      try {
        var payload = firmDomain ? { firmDomain: firmDomain } : { persona: persona, country: country || undefined };
        await apiFetch("/api/discover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        showMsg(f, "Discovery queued. Candidates appear below in ~60s.", "ok");
        pollActiveJobs();
        setTimeout(function () { pollCandidates(firmDomain); }, 5000);
        setTimeout(function () { pollCandidates(firmDomain); }, 30000);
      } catch (err) {
        showMsg(f, "Failed: " + err.message, "err");
      } finally {
        btn.disabled = false;
      }
    });
    pollCandidates();
  }

  // ---------------- Firm-list import tab ----------------
  function setupFirmlistForm() {
    var f = document.getElementById("ads-form-firmlist");
    if (!f) return;
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = f.querySelector("button[type=submit]");
      btn.disabled = true; showMsg(f, "Queuing…");
      var fd = new FormData(f);
      var raw = String(fd.get("urls") || "");
      var importer = String(fd.get("importer") || "").trim();
      var seen = {};
      var urls = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) {
        if (!s) return false;
        if (seen[s]) return false;
        seen[s] = true;
        return true;
      }).slice(0, 50);
      if (!urls.length) { showMsg(f, "Provide at least one URL.", "err"); btn.disabled = false; return; }
      try {
        var res = await apiFetch("/api/import/firmlists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(importer ? { urls: urls, importer: importer } : { urls: urls }),
        });
        var enq = res && res.enqueued != null ? res.enqueued : urls.length;
        var rejected = (res && res.results ? res.results.filter(function (r) { return r.error; }) : []);
        var msg = "Queued " + enq + " import job(s)";
        if (rejected.length) msg += " · " + rejected.length + " rejected (" + (rejected[0].error || "?") + ")";
        showMsg(f, msg, rejected.length ? "warn" : "ok");
        if (enq > 0) pollActiveJobs();
      } catch (err) {
        showMsg(f, "Failed: " + err.message, "err");
      } finally {
        btn.disabled = false;
      }
    });
    var refreshBtn = document.getElementById("ads-firmlist-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", loadFirmlistHistory);
    loadFirmlistHistory();
    var nfxBtn = document.getElementById("ads-nfx-submit");
    if (nfxBtn) {
      nfxBtn.addEventListener("click", async function () {
        var ta = f.querySelector('textarea[name="nfx_paste"]');
        var msgEl = f.querySelector('[data-msg-nfx]');
        if (!ta || !ta.value.trim()) { if (msgEl) { msgEl.textContent = "Paste JSON rows first."; } return; }
        var rows;
        try { rows = JSON.parse(ta.value); }
        catch (err) { if (msgEl) { msgEl.textContent = "Invalid JSON: " + err.message; } return; }
        if (!Array.isArray(rows) || !rows.length) { if (msgEl) { msgEl.textContent = "Expected non-empty JSON array."; } return; }
        nfxBtn.disabled = true;
        if (msgEl) msgEl.textContent = "Submitting " + rows.length + " row(s)…";
        try {
          var r = await apiFetch("/api/import/nfx/paste", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: rows, source_url: "https://signal.nfx.com/" }),
          });
          if (msgEl) msgEl.textContent = "Created " + (r.created || 0) + " · updated " + (r.updated || 0) + " · unchanged " + (r.unchanged || 0);
          ta.value = "";
        } catch (err) {
          if (msgEl) msgEl.textContent = "Failed: " + err.message;
        } finally {
          nfxBtn.disabled = false;
        }
      });
    }
  }

  async function loadFirmlistHistory() {
    var totalsEl = document.getElementById("ads-firmlist-totals");
    var byEl = document.getElementById("ads-firmlist-by-importer");
    var listEl = document.getElementById("ads-firmlist-history");
    if (!totalsEl && !byEl && !listEl) return;
    var data;
    try { data = await api("/api/imports?limit=50"); }
    catch (e) { if (listEl) listEl.innerHTML = '<p class="ads-muted">Failed: ' + escapeHtml(e.message) + '</p>'; return; }
    if (!data) { if (listEl) listEl.innerHTML = '<p class="ads-muted">API unavailable.</p>'; return; }
    var t = data.totals || {};
    if (totalsEl) {
      totalsEl.innerHTML =
        kpiPill("Jobs", t.jobs) + kpiPill("Seen", t.total_seen) +
        kpiPill("Created", t.created) + kpiPill("Updated", t.updated) +
        kpiPill("Unchanged", t.unchanged) + kpiPill("Child crawls", t.child_jobs) +
        kpiPill("Errors", t.errors);
    }
    if (byEl) {
      var keys = Object.keys(data.by_importer || {});
      if (!keys.length) { byEl.innerHTML = '<p class="ads-muted">No imports yet.</p>'; }
      else {
        byEl.innerHTML = '<table class="ads-table"><thead><tr><th>Importer</th><th>Jobs</th><th>Seen</th><th>Created</th><th>Updated</th><th>Unchanged</th><th>Errors</th></tr></thead><tbody>' +
          keys.map(function (k) {
            var v = data.by_importer[k];
            return '<tr><td>' + escapeHtml(k) + '</td><td>' + fmtInt(v.jobs) + '</td><td>' + fmtInt(v.total_seen) + '</td><td>' + fmtInt(v.created) + '</td><td>' + fmtInt(v.updated) + '</td><td>' + fmtInt(v.unchanged) + '</td><td>' + fmtInt(v.errors) + '</td></tr>';
          }).join("") + '</tbody></table>';
      }
    }
    if (listEl) {
      var items = data.items || [];
      if (!items.length) { listEl.innerHTML = ""; }
      else {
        listEl.innerHTML = '<table class="ads-table"><thead><tr><th>When</th><th>Importer</th><th>Target</th><th>Status</th><th>Seen</th><th>Created</th><th>Updated</th><th>Unchanged</th><th>Errors</th></tr></thead><tbody>' +
          items.map(function (it) {
            return '<tr><td>' + escapeHtml(it.started_at || it.created_at || "—") + '</td><td>' + escapeHtml(it.importer || "—") + '</td><td title="' + escapeHtml(it.target || "") + '">' + escapeHtml(truncate(it.target || "", 60)) + '</td><td>' + escapeHtml(it.status || "—") + '</td><td>' + fmtInt(it.total_seen) + '</td><td>' + fmtInt(it.created) + '</td><td>' + fmtInt(it.updated) + '</td><td>' + fmtInt(it.unchanged) + '</td><td>' + fmtInt((it.errors || []).length) + '</td></tr>';
          }).join("") + '</tbody></table>';
      }
    }
  }
  function kpiPill(label, val) {
    return '<span class="ads-pill"><b>' + fmtInt(val) + '</b> ' + escapeHtml(label) + '</span>';
  }
  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]; }); }

  // Approve / reject candidate delegates.
  document.addEventListener("click", async function (e) {
    var ok = e.target.closest("button[data-resolve-cand]");
    var no = e.target.closest("button[data-reject-cand]");
    if (!ok && !no) return;
    var id = (ok || no).getAttribute(ok ? "data-resolve-cand" : "data-reject-cand");
    var path = "/api/discover/" + encodeURIComponent(id) + (ok ? "/resolve" : "/reject");
    (ok || no).disabled = true;
    try {
      await apiFetch(path, { method: "POST" });
      pollCandidates();
      pollActiveJobs();
    } catch (err) { (ok || no).disabled = false; console.warn("candidate action failed", err); }
  });

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
    setupDiscoverForm();
    setupFirmlistForm();
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
