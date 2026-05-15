// Uploads dashboard — file upload + column-mapping confirm + status polling.
// Talks to the worker at window.adsApiBase via window.adsApiFetch (set by
// dashboard.js).

(function () {
  var API_BASE = window.adsApiBase || "https://api.aidatasignal.com";
  var apiFetch = window.adsApiFetch || function (path, opts) {
    return fetch(API_BASE + path, Object.assign({ credentials: "include" }, opts || {})).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("HTTP " + r.status)); });
      return r.json();
    });
  };

  // Field catalog used to populate per-column dropdowns in the mapping UI.
  var FIELD_CATALOG = [
    { v: "__skip__", label: "— skip —" },
    { v: "firms.name", label: "Firms › Name" },
    { v: "firms.legal_name", label: "Firms › Legal name" },
    { v: "firms.website", label: "Firms › Website" },
    { v: "firms.domain", label: "Firms › Domain" },
    { v: "firms.kind", label: "Firms › Kind" },
    { v: "firms.thesis", label: "Firms › Thesis" },
    { v: "firms.stages", label: "Firms › Stages" },
    { v: "firms.sectors", label: "Firms › Sectors" },
    { v: "firms.geo_focus", label: "Firms › Geo focus" },
    { v: "firms.hq_city", label: "Firms › HQ city" },
    { v: "firms.hq_region", label: "Firms › HQ region" },
    { v: "firms.hq_country_iso2", label: "Firms › HQ country (ISO2)" },
    { v: "firms.check_size_typical_usd", label: "Firms › Check (typical USD)" },
    { v: "firms.check_size_min_usd", label: "Firms › Check min USD" },
    { v: "firms.check_size_max_usd", label: "Firms › Check max USD" },
    { v: "firms.aum_usd", label: "Firms › AUM USD" },
    { v: "firms.current_fund_size_usd", label: "Firms › Fund size USD" },
    { v: "firms.current_fund_name", label: "Firms › Fund name" },
    { v: "firms.fund_count", label: "Firms › Fund count" },
    { v: "firms.portfolio_count", label: "Firms › Portfolio count" },
    { v: "firms.notable_investments", label: "Firms › Notable investments" },
    { v: "firms.founded_year", label: "Firms › Founded year" },
    { v: "firms.team_size", label: "Firms › Team size" },
    { v: "firms.linkedin_url", label: "Firms › LinkedIn URL" },
    { v: "firms.crunchbase_url", label: "Firms › Crunchbase URL" },
    { v: "firms.twitter_handle", label: "Firms › Twitter handle" },
    { v: "firms.signal_nfx_url", label: "Firms › Signal NFX URL" },
    { v: "firms.openvc_url", label: "Firms › OpenVC URL" },
    { v: "firms.submission_url", label: "Firms › Submission URL" },
    { v: "leads.name", label: "Leads › Name" },
    { v: "leads.email", label: "Leads › Email" },
    { v: "leads.title", label: "Leads › Title" },
    { v: "leads.org", label: "Leads › Org / company" },
    { v: "leads.linkedin_url", label: "Leads › LinkedIn URL" },
    { v: "leads.twitter_url", label: "Leads › Twitter URL" },
    { v: "leads.phone", label: "Leads › Phone" }
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmtInt(n) { return n == null ? "—" : new Intl.NumberFormat("en-US").format(n); }
  function fmtSize(b) {
    if (b == null) return "—";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
    return (Math.round((b / 1024 / 1024) * 10) / 10) + " MB";
  }

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "ads-form-msg" + (kind ? (" ads-form-msg--" + kind) : "");
  }

  // ---- List ----
  function renderList(items) {
    var c = document.getElementById("ads-uploads-list");
    if (!c) return;
    if (!items || !items.length) {
      c.innerHTML = '<div class="ads-empty">No uploads yet.</div>';
      return;
    }
    var html =
      '<div class="ads-table-wrap"><table class="ads-table"><thead><tr>' +
      '<th>File</th><th>Status</th><th>Entity</th><th>Rows</th><th>Imported</th>' +
      '<th>Firms +/Δ</th><th>Leads +/Δ</th><th>URLs queued</th><th>When</th><th></th>' +
      '</tr></thead><tbody>';
    items.forEach(function (it) {
      var pillCls = it.status === "done" ? "ok" :
                    (it.status === "error" ? "err" :
                    (it.status === "importing" || it.status === "parsing" ? "warn" : "idle"));
      html += '<tr data-id="' + esc(it.id) + '">' +
        '<td>' + esc(it.filename) + ' <span class="ads-muted">(' + esc(fmtSize(it.size)) + ')</span></td>' +
        '<td><span class="ads-pill ' + pillCls + '">' + esc(it.status) + '</span>' +
          (it.error ? ' <span class="ads-muted" title="' + esc(it.error) + '">error</span>' : '') + '</td>' +
        '<td>' + esc(it.entity || "—") + '</td>' +
        '<td>' + fmtInt(it.row_count) + '</td>' +
        '<td>' + fmtInt(it.rows_imported) + '</td>' +
        '<td>' + fmtInt(it.firms_created) + ' / ' + fmtInt(it.firms_updated) + '</td>' +
        '<td>' + fmtInt(it.leads_created) + ' / ' + fmtInt(it.leads_updated) + '</td>' +
        '<td>' + fmtInt(it.queued_jobs) + '</td>' +
        '<td>' + esc(it.created_at ? new Date(it.created_at).toLocaleString() : "—") + '</td>' +
        '<td>' +
          '<button class="ads-btn ads-btn--ghost ads-btn--sm" data-act="open" data-id="' + esc(it.id) + '">Review</button> ' +
          '<button class="ads-btn ads-btn--ghost ads-btn--sm" data-act="rerun" data-id="' + esc(it.id) + '">Re-parse</button> ' +
          '<button class="ads-btn ads-btn--ghost ads-btn--sm" data-act="delete" data-id="' + esc(it.id) + '">Delete</button>' +
        '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    c.innerHTML = html;
  }

  function loadList() {
    return apiFetch("/api/uploads?limit=100").then(function (r) {
      renderList((r && r.items) || []);
    }).catch(function (e) {
      var c = document.getElementById("ads-uploads-list");
      if (c) c.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>';
    });
  }

  // ---- Upload ----
  function uploadFile(file, msgEl) {
    var fd = new FormData();
    fd.append("file", file);
    setMsg(msgEl, "Uploading " + file.name + "…", "warn");
    return fetch(API_BASE + "/api/uploads", { method: "POST", credentials: "include", body: fd })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("HTTP " + r.status)); });
        return r.json();
      })
      .then(function (j) {
        setMsg(msgEl, "Uploaded — parsing…", "ok");
        // Poll for parse completion, then auto-open the review modal.
        return waitForStatus(j.id, ["mapped", "error"], 60).then(function () {
          openDetail(j.id);
          loadList();
        });
      })
      .catch(function (e) {
        setMsg(msgEl, "Failed: " + e.message, "err");
        throw e;
      });
  }

  function waitForStatus(id, terminals, maxSeconds) {
    var elapsed = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        elapsed += 2;
        apiFetch("/api/uploads/" + encodeURIComponent(id)).then(function (row) {
          if (terminals.indexOf(row.status) >= 0 || elapsed >= maxSeconds) {
            clearInterval(iv); resolve(row);
          }
        }).catch(function () { /* keep polling */ });
      }, 2000);
    });
  }

  // ---- Detail / map confirmation ----
  function openDetail(id) {
    var modal = document.getElementById("ads-upload-detail-modal");
    var body = document.getElementById("ads-upload-detail-body");
    if (!modal || !body) return;
    modal.hidden = false;
    body.innerHTML = '<div class="ads-empty">Loading…</div>';
    apiFetch("/api/uploads/" + encodeURIComponent(id)).then(function (row) {
      renderDetail(row);
    }).catch(function (e) {
      body.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>';
    });
  }

  function closeDetail() {
    var modal = document.getElementById("ads-upload-detail-modal");
    if (modal) modal.hidden = true;
  }

  function renderDetail(row) {
    var body = document.getElementById("ads-upload-detail-body");
    if (!body) return;
    var preview = row.preview || { headers: [], rows: [] };
    var map = row.column_map || {};
    var urls = row.urls || [];

    var html = '';
    html += '<p><b>' + esc(row.filename) + '</b> · ' + esc(fmtSize(row.size)) +
            ' · status <span class="ads-pill">' + esc(row.status) + '</span>' +
            (row.error ? ' · <span class="ads-muted">' + esc(row.error) + '</span>' : '') + '</p>';
    if (row.status === "uploaded" || row.status === "parsing") {
      html += '<div class="ads-empty">Parsing… reload in a moment.</div>';
      body.innerHTML = html;
      return;
    }
    if (row.status === "error") {
      html += '<div class="ads-empty">Parse failed.</div>';
      body.innerHTML = html;
      return;
    }
    html += '<div style="display:flex;gap:16px;align-items:center;margin-bottom:8px">' +
              '<label>Entity ' +
                '<select id="ads-upload-entity">' +
                  '<option value="firms"' + (row.entity === "leads" ? '' : ' selected') + '>Firms</option>' +
                  '<option value="leads"' + (row.entity === "leads" ? ' selected' : '') + '>Leads</option>' +
                '</select>' +
              '</label>' +
              '<label><input type="checkbox" id="ads-upload-scrape-urls" checked> Auto-queue scrape jobs for ' +
                fmtInt(urls.length) + ' URL(s) found</label>' +
            '</div>';

    // Mapping table
    html += '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Header</th><th>Maps to</th><th>Sample 1</th><th>Sample 2</th></tr></thead><tbody>';
    preview.headers.forEach(function (h) {
      var current = (map[h] && (map[h].entity ? (map[h].entity + "." + map[h].field) : map[h])) || "__skip__";
      var samples = preview.rows.map(function (r) { return r[h] || ""; });
      html += '<tr><td>' + esc(h) + '</td><td>' + selectFor(h, current) + '</td>' +
              '<td><span class="ads-muted">' + esc(samples[0] || "") + '</span></td>' +
              '<td><span class="ads-muted">' + esc(samples[1] || "") + '</span></td></tr>';
    });
    html += '</tbody></table></div>';

    if (urls.length) {
      html += '<details style="margin-top:12px"><summary>Found URLs (' + fmtInt(urls.length) + ')</summary>' +
              '<ul style="max-height:160px;overflow:auto;padding-left:18px;margin-top:6px">' +
              urls.slice(0, 200).map(function (u) { return '<li><a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + '</a></li>'; }).join("") +
              '</ul></details>';
    }

    html += '<div class="ads-form-actions" style="margin-top:16px">' +
              '<button class="ads-btn" id="ads-upload-confirm" data-id="' + esc(row.id) + '">Confirm map &amp; import</button>' +
              '<span class="ads-form-msg" id="ads-upload-confirm-msg"></span>' +
            '</div>';
    body.innerHTML = html;
  }

  function selectFor(header, currentValue) {
    var safeId = "map-" + header.replace(/[^a-z0-9]+/gi, "_");
    var html = '<select data-header="' + esc(header) + '" id="' + esc(safeId) + '">';
    FIELD_CATALOG.forEach(function (f) {
      html += '<option value="' + esc(f.v) + '"' + (f.v === currentValue ? ' selected' : '') + '>' + esc(f.label) + '</option>';
    });
    html += '</select>';
    return html;
  }

  function confirmMap(id) {
    var msg = document.getElementById("ads-upload-confirm-msg");
    var entity = (document.getElementById("ads-upload-entity") || {}).value || "firms";
    var scrape = !!(document.getElementById("ads-upload-scrape-urls") || {}).checked;
    var sels = document.querySelectorAll("[data-header]");
    var map = {};
    sels.forEach(function (s) { map[s.getAttribute("data-header")] = s.value; });
    setMsg(msg, "Submitting…", "warn");
    apiFetch("/api/uploads/" + encodeURIComponent(id) + "/confirm-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column_map: map, entity: entity, scrape_urls: scrape }),
    }).then(function () {
      setMsg(msg, "Import queued. Polling for completion…", "ok");
      return waitForStatus(id, ["done", "error"], 600);
    }).then(function () {
      setMsg(msg, "Done.", "ok");
      loadList();
      setTimeout(closeDetail, 800);
    }).catch(function (e) {
      setMsg(msg, "Failed: " + e.message, "err");
    });
  }

  function rerun(id) {
    apiFetch("/api/uploads/" + encodeURIComponent(id) + "/rerun", { method: "POST" })
      .then(loadList).catch(function (e) { alert("Rerun failed: " + e.message); });
  }
  function del(id) {
    if (!confirm("Delete this upload? This removes the file and the file_imports row.")) return;
    apiFetch("/api/uploads/" + encodeURIComponent(id), { method: "DELETE" })
      .then(loadList).catch(function (e) { alert("Delete failed: " + e.message); });
  }

  // ---- Wiring ----
  function init() {
    var form = document.getElementById("ads-uploads-form");
    var msg = document.getElementById("ads-uploads-msg");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var fileInput = form.querySelector('input[type="file"]');
        if (!fileInput || !fileInput.files || !fileInput.files[0]) { setMsg(msg, "Pick a file first.", "err"); return; }
        uploadFile(fileInput.files[0], msg);
      });
    }
    var refresh = document.getElementById("ads-uploads-refresh");
    if (refresh) refresh.addEventListener("click", loadList);

    document.addEventListener("click", function (e) {
      var t = e.target.closest("button[data-act]");
      if (t) {
        var id = t.getAttribute("data-id");
        var act = t.getAttribute("data-act");
        if (act === "open") openDetail(id);
        else if (act === "rerun") rerun(id);
        else if (act === "delete") del(id);
        return;
      }
      var confirmBtn = e.target.closest("#ads-upload-confirm");
      if (confirmBtn) confirmMap(confirmBtn.getAttribute("data-id"));
    });
    var closeBtn = document.getElementById("ads-upload-detail-close");
    if (closeBtn) closeBtn.addEventListener("click", closeDetail);

    loadList();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose for the dashboard's inline Import-file tab.
  window.adsUploads = { uploadFile: uploadFile, openDetail: openDetail, loadList: loadList };
})();
