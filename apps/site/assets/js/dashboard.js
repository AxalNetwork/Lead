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
    var html = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Name</th><th>Org</th><th>Source</th><th>Status</th></tr></thead><tbody>';
    items.forEach(function (l) {
      var pillCls = l.status === "approved" ? "ok" : l.status === "pending" ? "warn" : l.status === "flagged" ? "err" : "idle";
      html += "<tr><td>" + esc(l.name || "—") + "</td><td>" + esc(l.org || "—") + "</td><td>" + esc(l.source_domain || "—") + '</td><td><span class="ads-pill ' + pillCls + '">' + esc(l.status || "new") + "</span></td></tr>";
    });
    html += "</tbody></table></div>";
    c.innerHTML = html;
  }

  function renderTopSources(items) {
    var c = document.getElementById("ads-top-sources");
    if (!c) return;
    if (!items || !items.length) return renderEmpty(c, "No source data yet.");
    var html = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Domain</th><th>Leads</th></tr></thead><tbody>';
    items.forEach(function (s) {
      html += "<tr><td>" + esc(s.domain) + "</td><td>" + fmtInt(s.lead_count) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    c.innerHTML = html;
  }

  function renderRecentJobs(items) {
    var c = document.getElementById("ads-recent-jobs");
    if (!c) return;
    if (!items || !items.length) return renderEmpty(c, "No jobs yet.");
    var html = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Job</th><th>Source</th><th>Status</th><th>Started</th></tr></thead><tbody>';
    items.forEach(function (j) {
      var pillCls = j.status === "completed" ? "ok" : j.status === "running" ? "warn" : j.status === "failed" ? "err" : "idle";
      html += "<tr><td>" + esc(j.name || j.id) + "</td><td>" + esc(j.source || "—") + '</td><td><span class="ads-pill ' + pillCls + '">' + esc(j.status || "queued") + "</span></td><td>" + (j.started_at ? esc(new Date(j.started_at).toLocaleString()) : "—") + "</td></tr>";
    });
    html += "</tbody></table></div>";
    c.innerHTML = html;
  }

  function renderCategories(items) {
    var c = document.getElementById("ads-leads-by-category");
    if (!c) return;
    if (!items || !items.length) return renderEmpty(c, "No categories yet.");
    var html = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Category</th><th>Leads</th></tr></thead><tbody>';
    items.forEach(function (cat) {
      html += "<tr><td>" + esc(cat.category) + "</td><td>" + fmtInt(cat.count) + "</td></tr>";
    });
    html += "</tbody></table></div>";
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
    var html = '<div class="ads-table-wrap"><table class="ads-table ads-table--active"><thead><tr><th>Job</th><th>Kind</th><th>Status</th><th>Pages</th><th>Leads</th><th>Elapsed</th><th></th></tr></thead><tbody>';
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
    html += "</tbody></table></div>";
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

    var current = { id: null, headers: [], map: {}, entity: "firms", totalRows: 0, pollHandle: null,
      tabs: [], tabPreviews: {}, activeTab: 0, summary: null };

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
      // Reset to the FULL v2 shape so re-entering the flow doesn't trip
      // over missing tabs/tabPreviews/activeTab/summary keys.
      current = { id: null, headers: [], map: {}, entity: "firms", totalRows: 0, pollHandle: null,
        tabs: [], tabPreviews: {}, activeTab: 0, summary: null };
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
      firms: ["name","website","domain","kind","thesis","stages","sectors","geo_focus","hq_city","hq_region","hq_country_iso2","check_size_typical_usd","check_size_min_usd","check_size_max_usd","aum_usd","current_fund_size_usd","current_fund_name","fund_count","portfolio_count","notable_investments","founded_year","team_size","linkedin_url","crunchbase_url","twitter_handle","signal_nfx_url","openvc_url","legal_name","submission_url","contact_email"],
      leads: ["name","email","phone","org","title","linkedin_url","twitter_url"],
      firm_metrics: ["aum_usd","deals_count","exits_count","new_funds","fund_size_usd","geo_pct","stage_pct","sector_pct","period","dimension"],
    };
    var INTENT_OPTIONS = [
      { v: "firms", label: "Firms (List)" },
      { v: "firm_metrics", label: "Time-series metrics" },
      { v: "firm_kpi", label: "KPI snapshot (Stats)" },
      { v: "firm_geo", label: "Geo allocation" },
      { v: "leads", label: "Leads / People" },
      { v: "notes", label: "Notes (skip)" },
      { v: "discard", label: "Discard" },
    ];

    function fieldOptionsHtml() {
      var opts = ['<option value="__skip__">— skip —</option>'];
      ["firms","leads","firm_metrics"].forEach(function (ent) {
        opts.push('<optgroup label="' + ent + '">');
        FIELD_OPTIONS[ent].forEach(function (f) {
          opts.push('<option value="' + ent + '.' + f + '">' + ent + '.' + f + '</option>');
        });
        opts.push("</optgroup>");
      });
      return opts.join("");
    }

    function showMapping(data) {
      stopPoll();
      var urls = data.urls || [];
      current.tabs = (data.tabs || []).map(function (t) {
        return {
          tab_index: t.tab_index,
          sheet_name: t.sheet_name,
          intent: t.intent || "firms",
          intent_subkind: t.intent_subkind || null,
          intent_confidence: t.intent_confidence || 0,
          row_count: t.row_count || 0,
          column_map: t.column_map || {},
          map_confidence: t.map_confidence || {},
        };
      });
      current.tabPreviews = data.tab_previews || {};
      current.summary = data.summary || null;
      current.activeTab = 0;
      // Legacy single-tab fallback when /tabs is empty (older parses).
      if (!current.tabs.length) {
        var headers = (data.preview && data.preview.headers) || [];
        var seed = data.column_map || {};
        current.tabs = [{
          tab_index: 0, sheet_name: null, intent: data.entity === "leads" ? "leads" : "firms",
          intent_subkind: null, intent_confidence: 0.5, row_count: data.row_count || 0,
          column_map: headers.reduce(function (acc, h) { acc[h] = seed[h] || "__skip__"; return acc; }, {}),
          map_confidence: {},
        }];
        current.tabPreviews = { "0": { headers: headers, rows: (data.preview && data.preview.rows) || [] } };
      }
      current.totalRows = data.row_count || current.tabs.reduce(function (a, t) { return a + (t.row_count || 0); }, 0);

      renderTabPanel();

      var tabSummary = current.tabs.length + " tab" + (current.tabs.length === 1 ? "" : "s")
        + " · " + current.totalRows + " rows"
        + (data.format ? " · " + data.format : "")
        + ((current.summary && current.summary.template_applied) ? " · template: " + escapeHtml(current.summary.template_applied.name) : "");
      summary.textContent = tabSummary;

      urlsSum.textContent = "URLs found (" + urls.length + ")";
      urlsBox.innerHTML = urls.length
        ? urls.slice(0, 200).map(function (u) { return escapeHtml(u); }).join("<br>")
        : "<em>(none)</em>";

      tellMsg("Parsed. Review each tab, then confirm.", "ok");
      setStep("map");
    }

    function renderTabPanel() {
      // Total rows across ALL tabs (multi-tab uploads must not show only
      // the primary tab's row_count — the operator needs the full picture).
      var totalAllTabs = current.tabs.reduce(function (a, t) { return a + (t.row_count || 0); }, 0);
      var pillsHtml = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">';
      current.tabs.forEach(function (t, i) {
        var rowCount = t.row_count || 0;
        var label = (t.sheet_name || ("Tab " + (i + 1))) + " · " + t.intent
          + " · " + rowCount + (rowCount === 1 ? " row" : " rows");
        var conf = Math.round((t.intent_confidence || 0) * 100);
        var active = i === current.activeTab;
        pillsHtml += '<button type="button" class="ads-tab-pill" data-tab="' + i + '" '
          + 'style="padding:4px 10px;border:1px solid ' + (active ? "#2c7be5" : "#ccc") + ';'
          + 'background:' + (active ? "#2c7be5" : "#fff") + ';color:' + (active ? "#fff" : "#333") + ';'
          + 'border-radius:14px;font-size:12px;cursor:pointer">'
          + escapeHtml(label) + ' <span style="opacity:.7">(' + conf + '%)</span></button>';
      });
      pillsHtml += '</div>';
      pillsHtml += '<div style="font-size:12px;color:#666;margin-bottom:10px">'
        + 'Total across tabs: <strong>' + totalAllTabs + '</strong> rows'
        + '</div>';

      // Save-template button on the right.
      pillsHtml += '<div style="margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<button type="button" id="ads-upload-save-template" '
        + 'style="padding:4px 10px;border:1px solid #ccc;background:#fafafa;border-radius:4px;font-size:12px;cursor:pointer">'
        + 'Save as template</button>'
        // Re-run pass without re-invoking the vision model (uses cached AI
        // results in KV so the re-run uses cached vision output only).
        + '<button type="button" id="ads-upload-rerun-skip-ocr" '
        + 'style="padding:4px 10px;border:1px solid #ccc;background:#fafafa;border-radius:4px;font-size:12px;cursor:pointer">'
        + 'Re-run (skip OCR)</button>'
        // Dry-run that surfaces would-create / would-update counts and a
        // sample of column-level diffs against existing firms.
        + '<button type="button" id="ads-upload-diff-preview" '
        + 'style="padding:4px 10px;border:1px solid #ccc;background:#fafafa;border-radius:4px;font-size:12px;cursor:pointer">'
        + 'Update existing firms — diff preview</button>'
        + '<span id="ads-upload-template-msg" style="font-size:12px;color:#666"></span>'
        + '</div>'
        + '<div id="ads-upload-diff-out" style="margin-bottom:10px;font-size:12px"></div>';

      // Active tab content.
      var tab = current.tabs[current.activeTab];
      var preview2 = current.tabPreviews[String(current.activeTab)] || { headers: [], rows: [] };
      var headers = preview2.headers;

      // Intent + subkind selectors.
      var intentSel = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">'
        + '<label style="font-size:12px;font-weight:600">Intent:</label>'
        + '<select id="ads-tab-intent" style="padding:4px;font-size:12px">';
      INTENT_OPTIONS.forEach(function (o) {
        intentSel += '<option value="' + o.v + '"' + (o.v === tab.intent ? " selected" : "") + '>' + o.label + '</option>';
      });
      intentSel += '</select>';
      intentSel += '<label style="font-size:12px;margin-left:10px">Subkind:</label>';
      intentSel += '<select id="ads-tab-subkind" style="padding:4px;font-size:12px">'
        + '<option value="">(none)</option>'
        + '<option value="gov_fund"' + (tab.intent_subkind === "gov_fund" ? " selected" : "") + '>gov_fund</option>'
        + '<option value="corporate"' + (tab.intent_subkind === "corporate" ? " selected" : "") + '>corporate</option>'
        + '<option value="angel"' + (tab.intent_subkind === "angel" ? " selected" : "") + '>angel</option>'
        + '</select></div>';

      // Build first-3 sample values per source column from the preview rows.
      var samples = {};
      headers.forEach(function (h) {
        var xs = [];
        for (var i = 0; i < preview2.rows.length && xs.length < 3; i++) {
          var v = String(preview2.rows[i][h] || "").trim();
          if (v) xs.push(v);
        }
        samples[h] = xs;
      });
      // Header rows: source · samples · target select · confidence bar.
      // Confidence thresholds (per spec):
      //   green  ≥ 0.85
      //   yellow 0.65 .. 0.85
      //   red    < 0.65
      var rowsHtml = '<div style="display:grid;grid-template-columns:1.4fr 1.6fr 1.6fr 90px;gap:6px;align-items:center;margin-bottom:6px">'
        + '<div style="font-size:11px;color:#666;font-weight:600">Source column</div>'
        + '<div style="font-size:11px;color:#666;font-weight:600">First 3 values</div>'
        + '<div style="font-size:11px;color:#666;font-weight:600">Target field</div>'
        + '<div style="font-size:11px;color:#666;font-weight:600">Confidence</div>'
        + '</div>';
      rowsHtml += '<div style="display:grid;grid-template-columns:1.4fr 1.6fr 1.6fr 90px;gap:6px;align-items:center">';
      headers.forEach(function (h) {
        var conf = Math.round((tab.map_confidence[h] || 0) * 100);
        var barColor = conf >= 85 ? "#2ecc71" : (conf >= 65 ? "#f1c40f" : "#e74c3c");
        var sampleHtml = samples[h].length
          ? samples[h].map(function (v) { return '<div style="font-size:11px;color:#444;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(v.length > 40 ? v.slice(0, 38) + "…" : v) + '</div>'; }).join("")
          : '<em style="font-size:11px;color:#999">(no values)</em>';
        rowsHtml += '<div style="font-size:13px"><code>' + escapeHtml(h) + '</code></div>';
        rowsHtml += '<div>' + sampleHtml + '</div>';
        rowsHtml += '<div><select data-h="' + escapeHtml(h) + '" style="width:100%;padding:4px;font-size:12px">'
          + fieldOptionsHtml() + '</select></div>';
        rowsHtml += '<div style="display:flex;align-items:center;gap:4px">'
          + '<div style="flex:1;height:6px;background:#eee;border-radius:3px;overflow:hidden">'
          + '<div style="width:' + conf + '%;height:100%;background:' + barColor + '"></div></div>'
          + '<span style="font-size:11px;color:#666;min-width:30px">' + conf + '%</span></div>';
      });
      rowsHtml += '</div>';

      mapPanel.innerHTML = pillsHtml + intentSel + rowsHtml;

      // Wire pills.
      mapPanel.querySelectorAll(".ads-tab-pill").forEach(function (b) {
        b.addEventListener("click", function () {
          current.activeTab = parseInt(b.getAttribute("data-tab"), 10);
          renderTabPanel();
        });
      });
      // Wire intent + subkind.
      var intentEl = mapPanel.querySelector("#ads-tab-intent");
      intentEl.addEventListener("change", function () {
        current.tabs[current.activeTab].intent = intentEl.value;
        renderTabPanel();
      });
      var subkindEl = mapPanel.querySelector("#ads-tab-subkind");
      subkindEl.addEventListener("change", function () {
        current.tabs[current.activeTab].intent_subkind = subkindEl.value || null;
      });
      // Wire selects: pre-select then bind change.
      mapPanel.querySelectorAll("select[data-h]").forEach(function (s) {
        var h = s.getAttribute("data-h");
        s.value = current.tabs[current.activeTab].column_map[h] || "__skip__";
        s.addEventListener("change", function () {
          current.tabs[current.activeTab].column_map[h] = s.value;
        });
      });
      // Re-run (skip OCR) button — re-classifies & re-maps using cached
      // vision results, so it never re-invokes the vision model.
      var rerunBtn = mapPanel.querySelector("#ads-upload-rerun-skip-ocr");
      var rerunMsg = mapPanel.querySelector("#ads-upload-template-msg");
      rerunBtn.addEventListener("click", async function () {
        rerunMsg.textContent = "Re-running…"; rerunMsg.style.color = "#666";
        try {
          var res = await fetch(API_BASE + "/api/uploads/" + current.id + "/rerun", {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ skip_ocr: true }),
          });
          if (!res.ok) throw new Error(await res.text());
          rerunMsg.textContent = "Re-run queued — refresh in a few seconds.";
          rerunMsg.style.color = "#2ecc71";
        } catch (err) {
          rerunMsg.textContent = "Re-run failed: " + err.message;
          rerunMsg.style.color = "#e74c3c";
        }
      });
      // Diff-preview button — shows would-create / would-update counts and
      // a sample of column diffs without writing anything.
      var diffBtn = mapPanel.querySelector("#ads-upload-diff-preview");
      var diffOut = mapPanel.querySelector("#ads-upload-diff-out");
      diffBtn.addEventListener("click", async function () {
        diffOut.innerHTML = '<em style="color:#666">Computing…</em>';
        try {
          var res = await fetch(API_BASE + "/api/uploads/" + current.id + "/diff-preview", {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" }, body: "{}",
          });
          if (!res.ok) throw new Error(await res.text());
          var j = await res.json();
          var ratioPct = Math.round((j.domain_exist_ratio || 0) * 100);
          var thresholdPct = Math.round((j.threshold || 0.8) * 100);
          var eligibleNote = j.eligible
            ? '<div style="margin-top:4px;color:#1e8449">Eligible: '
                + ratioPct + '% of rows with a domain already exist '
                + '(≥ ' + thresholdPct + '% threshold).</div>'
            : '<div style="margin-top:4px;color:#a04000">Not eligible: only '
                + ratioPct + '% of rows with a domain already exist '
                + '(need ≥ ' + thresholdPct + '%). Diff is shown for reference only.</div>';
          var html = '<div style="padding:8px;border:1px solid #ddd;border-radius:4px;background:#fafafa">'
            + '<div><strong>Would create:</strong> ' + (j.would_create_count || 0)
            + ' &nbsp; <strong>Would update:</strong> ' + (j.would_update_count || 0)
            + ' &nbsp; <span style="color:#666">(' + (j.rows_existing_by_domain || 0)
            + '/' + (j.rows_with_domain || 0) + ' rows matched by domain)</span></div>'
            + eligibleNote;
          if ((j.sample_diffs || []).length) {
            html += '<table class="ads-table" style="margin-top:6px;font-size:11px"><thead><tr>'
              + '<th>Tab</th><th>Key</th><th>Field</th><th>Old</th><th>New</th></tr></thead><tbody>';
            j.sample_diffs.forEach(function (d) {
              html += '<tr><td>' + d.tab + '</td><td>' + escapeHtml(d.key || '')
                + '</td><td><code>' + escapeHtml(d.field) + '</code></td>'
                + '<td>' + escapeHtml(String(d.old || '')) + '</td>'
                + '<td>' + escapeHtml(String(d.new || '')) + '</td></tr>';
            });
            html += '</tbody></table>';
          } else {
            html += '<div style="margin-top:6px;color:#666"><em>No column-level diffs sampled.</em></div>';
          }
          html += '</div>';
          diffOut.innerHTML = html;
        } catch (err) {
          diffOut.innerHTML = '<span style="color:#e74c3c">Diff failed: ' + escapeHtml(err.message) + '</span>';
        }
      });

      // Save template button.
      var saveBtn = mapPanel.querySelector("#ads-upload-save-template");
      var saveMsg = mapPanel.querySelector("#ads-upload-template-msg");
      saveBtn.addEventListener("click", async function () {
        var name = window.prompt("Template name?", (current.summary && current.summary.template_applied)
          ? current.summary.template_applied.name : "");
        if (!name) return;
        try {
          // Send the current per-tab edits in the same request so the saved
          // template snapshots the operator's in-memory state, not stale DB.
          var tabsPayload = current.tabs.map(function (t) {
            return {
              tab_index: t.tab_index,
              intent: t.intent,
              intent_subkind: t.intent_subkind,
              column_map: t.column_map,
            };
          });
          var res = await fetch(API_BASE + "/api/uploads/" + current.id + "/save-template", {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name, tabs: tabsPayload }),
          });
          if (!res.ok) throw new Error(await res.text());
          var j = await res.json();
          saveMsg.textContent = "Saved (" + (j.id || "").slice(0, 8) + ").";
          saveMsg.style.color = "#2ecc71";
        } catch (err) {
          saveMsg.textContent = "Failed: " + err.message;
          saveMsg.style.color = "#e74c3c";
        }
      });

      // Active-tab preview table — 10 rows with bad-cell highlighting.
      // A cell is "bad" when its mapped target has a type-specific parse
      // failure: money/year/url/iso2 fields whose value cannot be coerced
      // are tinted red; empty cells in mapped (non-skip) columns are tinted
      // yellow so the operator can spot data-loss patterns.
      if (preview2.rows.length) {
        var t = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr>'
          + headers.map(function (h) { return "<th>" + escapeHtml(h) + "</th>"; }).join("")
          + "</tr></thead><tbody>";
        preview2.rows.slice(0, 10).forEach(function (r) {
          t += "<tr>" + headers.map(function (h) {
            var v = String(r[h] || "");
            var target = tab.column_map[h] || "__skip__";
            var bg = "";
            if (target !== "__skip__") {
              if (!v.trim()) bg = "background:#fff8e1";
              else if (!validateCell(v, target)) bg = "background:#ffe5e5";
            }
            return '<td' + (bg ? ' style="' + bg + '"' : '') + '>' + escapeHtml(v) + '</td>';
          }).join("") + "</tr>";
        });
        t += "</tbody></table></div>";
        preview.innerHTML = t;
      } else {
        preview.innerHTML = "<em>(no preview rows)</em>";
      }
    }

    // Lightweight cell validator mirroring the worker-side coercers. Used by
    // the preview pane to flag bad cells before the operator hits Confirm.
    function validateCell(v, target) {
      if (!target || target === "__skip__") return true;
      var s = v.trim(); if (!s) return true;
      var dot = target.indexOf("."); if (dot < 0) return true;
      var f = target.slice(dot + 1);
      if (/_url$|website|linkedin|crunchbase|signal_nfx|openvc|submission/.test(f)) {
        return /https?:\/\//i.test(s) || /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+/i.test(s);
      }
      if (f === "hq_country_iso2") {
        return /^[a-z]{2}$/i.test(s) || /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(s) || s.length >= 3;
      }
      if (/year|founded|inception|vintage/.test(f)) {
        return /\b(19|20)\d{2}\b/.test(s) || /\bFY\s*['"]?(\d{2})\b/i.test(s) || /^['']?\d{2}$/.test(s);
      }
      if (/_count$|portfolio_count|fund_count|team_size/.test(f)) {
        return /\d/.test(s);
      }
      if (/_usd$|size|amount|aum|raised|exit/.test(f)) {
        return /[\d.,]/.test(s);
      }
      if (f === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
      return true;
    }

    // ---- step 3: progress ---------------------------------------------
    async function submitConfirmMap(force) {
      // Build per-tab payload.
      var tabsPayload = current.tabs.map(function (t) {
        return {
          tab_index: t.tab_index,
          intent: t.intent,
          intent_subkind: t.intent_subkind,
          column_map: t.column_map,
        };
      });
      // Primary tab's map drives the legacy column_map field.
      var primary = current.tabs[0] || { column_map: {}, intent: "firms" };
      var body = {
        column_map: primary.column_map,
        entity: primary.intent === "leads" ? "leads" : "firms",
        scrape_urls: scrapeChk.checked ? 1 : 0,
        tabs: tabsPayload,
      };
      var url = API_BASE + "/api/uploads/" + current.id + "/confirm-map" + (force ? "?force=1" : "");
      var res = await fetch(url, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_e) { data = null; }
      return { res: res, data: data, text: text };
    }

    confirmBtn.addEventListener("click", async function () {
      try {
        confirmBtn.disabled = true;
        var out = await submitConfirmMap(false);
        // If the server says we're already importing, surface a clear
        // "cancel & re-map" affordance instead of a raw JSON error.
        // The operator can edit any column dropdown, then click Re-map
        // to cancel the in-flight job and re-confirm with ?force=1.
        if (!out.res.ok && out.data && out.data.error === "bad_state" && out.data.status === "importing") {
          confirmBtn.textContent = "Cancel running import & re-map";
          confirmBtn.disabled = false;
          tellMsg("This file is already importing. Edit any mapping above, then click again to cancel the running import and re-map.", "warn");
          confirmBtn.onclick = async function () {
            try {
              confirmBtn.disabled = true;
              var out2 = await submitConfirmMap(true);
              if (!out2.res.ok) throw new Error(out2.text || ("HTTP " + out2.res.status));
              confirmBtn.onclick = null;
              confirmBtn.textContent = "Confirm map & import";
              setStep("progress");
              progMeta.textContent = "Re-importing " + current.totalRows + " rows across " + current.tabs.length + " tab(s)…";
              bar.style.width = "0%";
              counts.innerHTML = "";
              pollProgress();
            } catch (err2) {
              tellMsg("Re-map failed: " + err2.message, "err");
              confirmBtn.disabled = false;
            }
          };
          return;
        }
        if (!out.res.ok) throw new Error(out.text || ("HTTP " + out.res.status));
        setStep("progress");
        progMeta.textContent = "Importing " + current.totalRows + " rows across " + current.tabs.length + " tab(s)…";
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
    var html = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Name / Title</th><th>Source</th><th>URL</th><th>Persona</th><th></th></tr></thead><tbody>';
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
    html += '</tbody></table></div>';
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
        byEl.innerHTML = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Importer</th><th>Jobs</th><th>Seen</th><th>Created</th><th>Updated</th><th>Unchanged</th><th>Errors</th></tr></thead><tbody>' +
          keys.map(function (k) {
            var v = data.by_importer[k];
            return '<tr><td>' + escapeHtml(k) + '</td><td>' + fmtInt(v.jobs) + '</td><td>' + fmtInt(v.total_seen) + '</td><td>' + fmtInt(v.created) + '</td><td>' + fmtInt(v.updated) + '</td><td>' + fmtInt(v.unchanged) + '</td><td>' + fmtInt(v.errors) + '</td></tr>';
          }).join("") + '</tbody></table></div>';
      }
    }
    if (listEl) {
      var items = data.items || [];
      if (!items.length) { listEl.innerHTML = ""; }
      else {
        listEl.innerHTML = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>When</th><th>Importer</th><th>Target</th><th>Status</th><th>Seen</th><th>Created</th><th>Updated</th><th>Unchanged</th><th>Errors</th></tr></thead><tbody>' +
          items.map(function (it) {
            return '<tr><td>' + escapeHtml(it.started_at || it.created_at || "—") + '</td><td>' + escapeHtml(it.importer || "—") + '</td><td title="' + escapeHtml(it.target || "") + '">' + escapeHtml(truncate(it.target || "", 60)) + '</td><td>' + escapeHtml(it.status || "—") + '</td><td>' + fmtInt(it.total_seen) + '</td><td>' + fmtInt(it.created) + '</td><td>' + fmtInt(it.updated) + '</td><td>' + fmtInt(it.unchanged) + '</td><td>' + fmtInt((it.errors || []).length) + '</td></tr>';
          }).join("") + '</tbody></table></div>';
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
    var email = me && me.email ? me.email : "";
    var el = document.getElementById("ads-user-email");
    if (el) el.textContent = email || "(not signed in)";
    if (window.ADS && window.ADS.ui && typeof window.ADS.ui.setUser === "function") {
      window.ADS.ui.setUser(email);
    }
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
          b.addEventListener("click", async function (e) {
            e.preventDefault(); e.stopPropagation();
            if (!(await window.ADS.ui.confirm({ title: "Delete export template?", body: "This template will no longer appear in the export menu.", confirmLabel: "Delete", danger: true }))) return;
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

  // (escapeHtml is defined once above near other render helpers.)

  // Pause polling when the tab is hidden to save quota.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }
    } else if (!activeTimer && document.getElementById("ads-active-jobs")) {
      startActiveJobsPolling();
    }
  });
})();
