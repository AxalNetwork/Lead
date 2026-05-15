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
  // 3-step inline upload flow on the dashboard:
  //   pick (drag/drop) -> map (auto-mapped headers + URL list) -> progress.
  function setupUploadForm() {
    var root = document.getElementById("ads-upload-flow");
    if (!root) return;
    var msgEl = document.getElementById("ads-upload-msg");
    var dropZone = document.getElementById("ads-upload-drop");
    var fileInput = document.getElementById("ads-upload-input");
    var pickPane = root.querySelector('[data-step-pane="pick"]');
    var mapPane = root.querySelector('[data-step-pane="map"]');
    var progPane = root.querySelector('[data-step-pane="progress"]');
    var summary = document.getElementById("ads-upload-summary");
    var mapPanel = document.getElementById("ads-upload-map-panel");
    var preview = document.getElementById("ads-upload-preview");
    var urlsBox = document.getElementById("ads-upload-urls");
    var urlsSum = document.getElementById("ads-upload-urls-summary");
    var confirmBtn = document.getElementById("ads-upload-confirm-inline");
    var backBtn = document.getElementById("ads-upload-back");
    var newBtn = document.getElementById("ads-upload-new");
    var scrapeChk = document.getElementById("ads-upload-scrape-urls");
    var bar = document.getElementById("ads-upload-progress-bar");
    var counts = document.getElementById("ads-upload-progress-counts");
    var progMeta = document.getElementById("ads-upload-progress-meta");

    var current = { id: null, headers: [], map: {}, totalRows: 0, pollHandle: null };

    function setStep(name) {
      root.setAttribute("data-step", name);
      pickPane.hidden = name !== "pick";
      mapPane.hidden = name !== "map";
      progPane.hidden = name !== "progress";
    }
    function tellMsg(s, kind) {
      if (!msgEl) return;
      msgEl.textContent = s || "";
      msgEl.className = "ads-form-msg" + (kind ? " ads-form-msg--" + kind : "");
    }
    function resetFlow() {
      stopPoll();
      current = { id: null, headers: [], map: {}, totalRows: 0, pollHandle: null };
      if (fileInput) fileInput.value = "";
      tellMsg("");
      setStep("pick");
    }
    function stopPoll() {
      if (current.pollHandle) { clearTimeout(current.pollHandle); current.pollHandle = null; }
    }

    // ---- step 1: pick / drop -------------------------------------------
    function pickFile() { if (fileInput) fileInput.click(); }
    dropZone.addEventListener("click", pickFile);
    dropZone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickFile(); }
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        dropZone.style.background = "#eef5ff";
        dropZone.style.borderColor = "#2c7be5";
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        dropZone.style.background = "#fafafa";
        dropZone.style.borderColor = "#bbb";
      });
    });
    dropZone.addEventListener("drop", function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) startUpload(dt.files[0]);
    });
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) startUpload(fileInput.files[0]);
    });

    async function startUpload(file) {
      if (file.size > 52428800) { tellMsg("File exceeds 50 MB.", "err"); return; }
      tellMsg("Uploading " + file.name + " (" + Math.round(file.size / 1024) + " KB)…", "warn");
      var fd = new FormData(); fd.append("file", file);
      try {
        var res = await fetch(API_BASE + "/api/uploads", { method: "POST", credentials: "include", body: fd });
        if (!res.ok) throw new Error(await res.text() || ("HTTP " + res.status));
        var row = await res.json();
        current.id = row.id;
        tellMsg("Parsing…", "warn");
        await pollUntilMapped();
      } catch (err) {
        tellMsg("Failed: " + err.message, "err");
      }
    }

    // ---- step 2: map ---------------------------------------------------
    async function pollUntilMapped() {
      var tries = 0;
      var loop = async function () {
        tries += 1;
        try {
          var res = await fetch(API_BASE + "/api/uploads/" + current.id, { credentials: "include" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          var data = await res.json();
          if (data.status === "mapped") return showMapping(data);
          if (data.status === "error") throw new Error(data.error || "parse failed");
          if (tries > 60) throw new Error("parse timed out");
          current.pollHandle = setTimeout(loop, 1500);
        } catch (err) { tellMsg("Failed: " + err.message, "err"); }
      };
      loop();
    }

    var FIELD_OPTIONS = {
      firms: ["name","website","domain","kind","thesis","stages","sectors","geo_focus","hq_city","hq_region","hq_country_iso2","check_size_typical_usd","check_size_min_usd","check_size_max_usd","aum_usd","current_fund_size_usd","current_fund_name","fund_count","portfolio_count","notable_investments","founded_year","team_size","linkedin_url","crunchbase_url","twitter_handle","signal_nfx_url","openvc_url","legal_name","submission_url"],
      leads: ["name","email","phone","org","title","linkedin_url","twitter_url"],
    };
    function showMapping(data) {
      stopPoll();
      var entity = data.entity || "firms";
      var headers = (data.preview && data.preview.headers) || [];
      var rows = (data.preview && data.preview.rows) || [];
      var urls = data.urls || [];
      current.headers = headers;
      current.map = {};
      // seed with auto-detected map
      var seed = data.column_map || {};
      var opts = ['<option value="__skip__">— skip —</option>'];
      ["firms","leads"].forEach(function (ent) {
        opts.push('<optgroup label="' + ent + '">');
        FIELD_OPTIONS[ent].forEach(function (f) {
          opts.push('<option value="' + ent + '.' + f + '">' + ent + '.' + f + '</option>');
        });
        opts.push("</optgroup>");
      });
      var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;align-items:center">';
      headers.forEach(function (h, i) {
        var sel = seed[h] || "__skip__";
        current.map[h] = sel;
        html += '<div style="font-size:13px"><code>' + escapeHtml(h) + '</code></div>';
        html += '<div><select data-h="' + escapeHtml(h) + '" style="width:100%;padding:4px;font-size:12px">' + opts.join("") + "</select></div>";
        // mark seed selection after render
        void i;
      });
      html += "</div>";
      mapPanel.innerHTML = html;
      // wire selects
      mapPanel.querySelectorAll("select[data-h]").forEach(function (s) {
        var h = s.getAttribute("data-h");
        s.value = current.map[h] || "__skip__";
        s.addEventListener("change", function () { current.map[h] = s.value; });
      });

      summary.textContent = (data.row_count || rows.length) + " rows · " + headers.length + " columns · entity: " + entity + (data.tables_found > 1 ? " · " + data.tables_found + " tables (extras → portfolio)" : "");
      // preview
      if (rows.length) {
        var t = '<table class="ads-table"><thead><tr>' + headers.map(function (h) { return "<th>" + escapeHtml(h) + "</th>"; }).join("") + "</tr></thead><tbody>";
        rows.slice(0, 5).forEach(function (r) {
          t += "<tr>" + headers.map(function (h) { return "<td>" + escapeHtml(String(r[h] || "")) + "</td>"; }).join("") + "</tr>";
        });
        t += "</tbody></table>";
        preview.innerHTML = t;
      } else { preview.innerHTML = "<em>(no rows)</em>"; }
      // urls
      urlsSum.textContent = "URLs found (" + urls.length + ")";
      urlsBox.innerHTML = urls.length
        ? urls.slice(0, 200).map(function (u) { return escapeHtml(u); }).join("<br>")
        : "<em>(none)</em>";
      current.totalRows = data.row_count || rows.length;

      tellMsg("Parsed. Confirm the column map.", "ok");
      setStep("map");
    }

    // ---- step 3: progress ---------------------------------------------
    confirmBtn.addEventListener("click", async function () {
      try {
        confirmBtn.disabled = true;
        var body = { column_map: current.map, scrape_urls: scrapeChk.checked ? 1 : 0 };
        var res = await fetch(API_BASE + "/api/uploads/" + current.id + "/confirm-map", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text() || ("HTTP " + res.status));
        setStep("progress");
        progMeta.textContent = "Importing " + current.totalRows + " rows…";
        bar.style.width = "0%";
        counts.innerHTML = "";
        pollProgress();
      } catch (err) {
        tellMsg("Confirm failed: " + err.message, "err");
        confirmBtn.disabled = false;
      }
    });

    function pollProgress() {
      stopPoll();
      var loop = async function () {
        try {
          var res = await fetch(API_BASE + "/api/uploads/" + current.id, { credentials: "include" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          var d = await res.json();
          var imported = d.rows_imported || 0;
          var total = d.row_count || current.totalRows || 1;
          bar.style.width = Math.min(100, Math.round((imported / Math.max(1, total)) * 100)) + "%";
          counts.innerHTML =
            "<div>Rows imported: <strong>" + imported + " / " + total + "</strong></div>" +
            "<div>Firms: " + (d.firms_created || 0) + " new, " + (d.firms_updated || 0) + " updated</div>" +
            "<div>Leads: " + (d.leads_created || 0) + " new, " + (d.leads_updated || 0) + " updated</div>" +
            "<div>Scrape jobs queued: " + (d.queued_jobs || 0) + "</div>";
          if (d.status === "done") {
            progMeta.textContent = "Done.";
            return;
          }
          if (d.status === "error") {
            progMeta.textContent = "Failed: " + (d.error || "unknown");
            return;
          }
          current.pollHandle = setTimeout(loop, 1500);
        } catch (err) {
          progMeta.textContent = "Polling failed: " + err.message;
        }
      };
      loop();
    }

    backBtn.addEventListener("click", resetFlow);
    newBtn.addEventListener("click", resetFlow);
  }
  // suppress lint complaints for the legacy inline showMsg helper used elsewhere
  void showMsg;

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
    setupUploadForm();
    setupLinktreeForm();
    setupBulkForm();
    setupDiscoverForm();
    setupFirmlistForm();
    startActiveJobsPolling();
    setupExportBuilder();
  });

  // -------- Custom export builder (Task #19) --------------------------
  // Mirror of the worker-side whitelist.
  var EXPORT_FIELDS = {
    leads: ["id","name","first_name","last_name","email","primary_email","primary_phone","primary_linkedin","phone","org","title","category","status","verified","persona_role","seniority","function_area","country_iso2","region","city","linkedin_url","twitter_url","github_url","personal_url","emails_json","socials_json","tags_json","sector_focus_json","provider","provider_score","source_domain","source_url","aum_usd","fund_size_usd","firm_name","firm_domain","firm_aum_usd","do_not_contact","sector_slug","geo_slug","created_at","updated_at"],
    firms: ["id","name","legal_name","slug","kind","website","domain","hq_country_iso2","hq_region","hq_city","geo_focus_json","stages_json","sectors_json","thesis","check_size_min_usd","check_size_max_usd","check_size_typical_usd","aum_usd","fund_count","current_fund_name","current_fund_size_usd","lead_or_co","portfolio_count","portfolio_count_actual","partner_count","gp_count","top_partner_name","unicorns_count","exits_count","founded_year","team_size","linkedin_url","crunchbase_url","twitter_handle","openvc_url","contact_email","status","quality_score","last_modified","created_at"],
    firm_people: ["firm_id","firm_name","firm_domain","firm_kind","firm_country_iso2","firm_aum_usd","role","is_decision_maker","started_at","ended_at","lead_id","name","email","primary_email","title","linkedin_url","twitter_url","country_iso2"],
    portfolio: ["id","firm_id","firm_name","firm_domain","firm_country_iso2","company_name","company_domain","company_url","investment_year","stage","amount_usd","is_lead","outcome","exit_value_usd","source_url","created_at"],
  };

  var exportState = { selected: [], activeIdx: -1 };

  function setupExportBuilder() {
    var btn = document.getElementById("ads-export-btn");
    var menu = document.getElementById("ads-export-menu");
    if (!btn || !menu) return;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) { loadExportMenu(); menu.hidden = false; btn.setAttribute("aria-expanded","true"); }
      else { menu.hidden = true; btn.setAttribute("aria-expanded","false"); }
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) {
        menu.hidden = true; btn.setAttribute("aria-expanded","false");
      }
    });
    document.getElementById("ads-export-cancel").addEventListener("click", closeExportModal);
    document.getElementById("ads-export-modal").addEventListener("click", function (e) {
      if (e.target.id === "ads-export-modal") closeExportModal();
    });
    document.getElementById("ads-export-entity").addEventListener("change", function () {
      exportState.selected = []; exportState.activeIdx = -1;
      renderExportColumns();
    });
    document.getElementById("ads-export-col-add").addEventListener("click", function () {
      var sel = document.getElementById("ads-export-cols-available");
      if (!sel.value) return;
      exportState.selected.push({ field: sel.value });
      exportState.activeIdx = exportState.selected.length - 1;
      renderExportColumns();
    });
    document.getElementById("ads-export-col-header").addEventListener("input", function (e) {
      if (exportState.activeIdx < 0) return;
      exportState.selected[exportState.activeIdx].header = e.target.value || undefined;
      renderExportColumns(true);
    });
    document.getElementById("ads-export-col-transform").addEventListener("change", function (e) {
      if (exportState.activeIdx < 0) return;
      exportState.selected[exportState.activeIdx].transform = e.target.value || undefined;
      renderExportColumns(true);
    });
    document.getElementById("ads-export-form").addEventListener("submit", function (e) {
      e.preventDefault(); downloadCustomExport();
    });
    document.getElementById("ads-export-save").addEventListener("click", saveExportTemplate);
  }

  function loadExportMenu() {
    var menu = document.getElementById("ads-export-menu");
    fetch(API_BASE + "/api/exports/templates", { credentials: "include" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = (data && data.items) || [];
        var html = "";
        var sys = items.filter(function (t) { return t.is_system; });
        var usr = items.filter(function (t) { return !t.is_system; });
        if (sys.length) {
          html += '<div class="ads-muted" style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Presets</div>';
          sys.forEach(function (t) {
            html += '<a href="#" class="ads-export-preset" data-id="' + t.id + '" style="display:block;padding:8px 12px;color:inherit;text-decoration:none">' + escapeHtml(t.name) + ' <span class="ads-muted" style="font-size:11px">(' + t.entity + ')</span></a>';
          });
        }
        if (usr.length) {
          html += '<div class="ads-muted" style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-top:1px solid #eee;margin-top:4px">Saved</div>';
          usr.forEach(function (t) {
            html += '<div style="display:flex;align-items:center;justify-content:space-between"><a href="#" class="ads-export-preset" data-id="' + t.id + '" style="flex:1;padding:8px 12px;color:inherit;text-decoration:none">' + escapeHtml(t.name) + ' <span class="ads-muted" style="font-size:11px">(' + t.entity + ')</span></a><button class="ads-export-del" data-id="' + t.id + '" style="background:none;border:none;color:#a00;cursor:pointer;padding:0 10px" title="Delete">&times;</button></div>';
          });
        }
        html += '<div style="border-top:1px solid #eee;margin-top:4px"><a href="#" id="ads-export-custom" style="display:block;padding:8px 12px;color:inherit;text-decoration:none"><strong>Custom…</strong></a></div>';
        menu.innerHTML = html;
        menu.querySelectorAll(".ads-export-preset").forEach(function (a) {
          a.addEventListener("click", function (e) {
            e.preventDefault();
            var t = items.find(function (x) { return String(x.id) === a.dataset.id; });
            if (t) runPresetDownload(t);
            menu.hidden = true;
          });
        });
        menu.querySelectorAll(".ads-export-del").forEach(function (b) {
          b.addEventListener("click", function (e) {
            e.preventDefault(); e.stopPropagation();
            if (!confirm("Delete this template?")) return;
            fetch(API_BASE + "/api/exports/templates/" + b.dataset.id, { method: "DELETE", credentials: "include" })
              .then(function () { loadExportMenu(); });
          });
        });
        var custom = document.getElementById("ads-export-custom");
        if (custom) custom.addEventListener("click", function (e) {
          e.preventDefault(); menu.hidden = true; openExportModal();
        });
      })
      .catch(function () { menu.innerHTML = '<div class="ads-muted" style="padding:8px 12px">Failed to load presets.</div>'; });
  }

  function runPresetDownload(t) {
    return postExportDownload({ entity: t.entity, columns: t.columns, filter: t.filter || {}, format: t.format || "csv" });
  }

  function openExportModal() {
    var modal = document.getElementById("ads-export-modal");
    exportState.selected = []; exportState.activeIdx = -1;
    document.getElementById("ads-export-template-name").value = "";
    document.getElementById("ads-export-msg").textContent = "";
    renderExportColumns();
    modal.hidden = false;
  }

  function closeExportModal() {
    document.getElementById("ads-export-modal").hidden = true;
  }

  function renderExportColumns(skipFocus) {
    var entity = document.getElementById("ads-export-entity").value;
    var avail = document.getElementById("ads-export-cols-available");
    var used = exportState.selected.map(function (c) { return c.field; });
    avail.innerHTML = (EXPORT_FIELDS[entity] || []).filter(function (f) {
      return used.indexOf(f) === -1;
    }).map(function (f) {
      return '<option value="' + f + '">' + f + '</option>';
    }).join("");
    var ol = document.getElementById("ads-export-cols-selected");
    ol.innerHTML = exportState.selected.map(function (c, i) {
      var label = c.field + (c.header ? ' → "' + c.header + '"' : "") + (c.transform ? " · " + c.transform : "");
      var active = i === exportState.activeIdx ? "background:#eef" : "";
      return '<li draggable="true" data-i="' + i + '" style="padding:6px 10px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;cursor:move;' + active + '"><span>' + escapeHtml(label) + '</span><button type="button" class="ads-export-rm" data-i="' + i + '" style="background:none;border:none;color:#a00;cursor:pointer">&times;</button></li>';
    }).join("");
    document.getElementById("ads-export-col-count").textContent = exportState.selected.length + " selected";
    ol.querySelectorAll("li").forEach(function (li) {
      li.addEventListener("click", function (e) {
        if (e.target.classList.contains("ads-export-rm")) return;
        exportState.activeIdx = Number(li.dataset.i);
        var cur = exportState.selected[exportState.activeIdx];
        document.getElementById("ads-export-col-header").value = cur.header || "";
        document.getElementById("ads-export-col-transform").value = cur.transform || "";
        renderExportColumns(true);
      });
      li.addEventListener("dragstart", function (e) { e.dataTransfer.setData("i", li.dataset.i); });
      li.addEventListener("dragover", function (e) { e.preventDefault(); });
      li.addEventListener("drop", function (e) {
        e.preventDefault();
        var from = Number(e.dataTransfer.getData("i")), to = Number(li.dataset.i);
        if (from === to) return;
        var moved = exportState.selected.splice(from, 1)[0];
        exportState.selected.splice(to, 0, moved);
        exportState.activeIdx = to;
        renderExportColumns();
      });
    });
    ol.querySelectorAll(".ads-export-rm").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        exportState.selected.splice(Number(b.dataset.i), 1);
        if (exportState.activeIdx >= exportState.selected.length) exportState.activeIdx = -1;
        renderExportColumns();
      });
    });
    if (!skipFocus && exportState.activeIdx >= 0) {
      var cur = exportState.selected[exportState.activeIdx];
      document.getElementById("ads-export-col-header").value = cur.header || "";
      document.getElementById("ads-export-col-transform").value = cur.transform || "";
    } else if (exportState.activeIdx < 0) {
      document.getElementById("ads-export-col-header").value = "";
      document.getElementById("ads-export-col-transform").value = "";
    }
  }

  function buildModalPayload() {
    var f = {};
    var st = document.getElementById("ads-export-filter-status").value.trim();
    var co = document.getElementById("ads-export-filter-country").value.trim();
    var sn = document.getElementById("ads-export-filter-since").value.trim();
    var kn = document.getElementById("ads-export-filter-kind").value.trim();
    if (st) f.status = st;
    if (co) f.country_iso2 = co;
    if (sn) f.since = sn;
    if (kn) f.kind = kn;
    if (document.getElementById("ads-export-filter-hasemail").checked) f.has_email = true;
    if (document.getElementById("ads-export-filter-merged").checked) f.include_merged = true;
    return {
      entity: document.getElementById("ads-export-entity").value,
      columns: exportState.selected,
      filter: f,
      format: document.getElementById("ads-export-format").value,
    };
  }

  function downloadCustomExport() {
    if (!exportState.selected.length) {
      document.getElementById("ads-export-msg").textContent = "Add at least one column.";
      return;
    }
    document.getElementById("ads-export-msg").textContent = "Downloading…";
    postExportDownload(buildModalPayload()).then(function () {
      document.getElementById("ads-export-msg").textContent = "Done.";
    }).catch(function (e) {
      document.getElementById("ads-export-msg").textContent = "Failed: " + (e && e.message ? e.message : e);
    });
  }

  function postExportDownload(payload) {
    return fetch(API_BASE + "/api/exports/csv", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("HTTP " + r.status)); });
      var disp = r.headers.get("Content-Disposition") || "";
      var m = /filename="([^"]+)"/.exec(disp);
      var name = m ? m[1] : (payload.entity + "." + payload.format);
      return r.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url; a.download = name; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
      });
    });
  }

  function saveExportTemplate() {
    var name = document.getElementById("ads-export-template-name").value.trim();
    if (!name) { document.getElementById("ads-export-msg").textContent = "Enter a template name first."; return; }
    if (!exportState.selected.length) { document.getElementById("ads-export-msg").textContent = "Add at least one column."; return; }
    var payload = buildModalPayload();
    payload.name = name;
    fetch(API_BASE + "/api/exports/templates", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
      document.getElementById("ads-export-msg").textContent = "Template saved.";
      loadExportMenu();
    }).catch(function (e) {
      document.getElementById("ads-export-msg").textContent = "Save failed: " + (e && e.message ? e.message : e);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  // Pause polling when the tab is hidden to save quota.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }
    } else if (!activeTimer && document.getElementById("ads-active-jobs")) {
      startActiveJobsPolling();
    }
  });
})();
