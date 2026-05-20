// Task #6 — Diligence list/start page.
(function () {
  var API = (window.ADS && window.ADS.API) || "https://api.aidatasignal.com";
  var OPTS = { credentials: "include" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function api(path, opts) {
    return fetch(API + path, Object.assign({}, OPTS, opts || {})).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 200)); });
      return r.json();
    });
  }

  var tmplSel = document.getElementById("d-template");
  var target = document.getElementById("d-target");
  var startBtn = document.getElementById("d-start");
  var startStatus = document.getElementById("d-start-status");
  var listEl = document.getElementById("d-list");

  function loadTemplates() {
    return api("/api/diligence/templates").then(function (b) {
      tmplSel.innerHTML = (b.items || []).map(function (t) {
        var label = t.name + (t.is_system ? " (system)" : "") + " — " + (t.check_keys ? t.check_keys.length : 0) + " checks";
        return '<option value="' + esc(t.id) + '">' + esc(label) + '</option>';
      }).join("");
    }).catch(function (e) {
      tmplSel.innerHTML = '<option value="">(failed to load templates)</option>';
      console.warn(e);
    });
  }

  function loadList() {
    listEl.textContent = "Loading…";
    return api("/api/diligence/runs").then(function (b) {
      var items = b.items || [];
      if (!items.length) { listEl.innerHTML = '<div class="ads-muted">No runs yet.</div>'; return; }
      var rows = items.map(function (r) {
        var score = r.overall_score == null ? "—" : Number(r.overall_score).toFixed(1);
        var by = r.by_status || {};
        return '<tr>' +
          '<td><a href="/dashboard/diligence/run/?id=' + encodeURIComponent(r.id) + '">' + esc(r.id.slice(0, 8)) + '…</a></td>' +
          '<td>' + esc(r.target_entity_id) + '</td>' +
          '<td>' + esc(r.status) + '</td>' +
          '<td>' + score + '</td>' +
          '<td>' + (r.checks_completed || 0) + '/' + (r.checks_total || 0) + '</td>' +
          '<td style="font-size:11px;color:#666">pass ' + (by.pass || 0) +
            ' · fail ' + (by.fail || 0) +
            ' · caution ' + (by.caution || 0) +
            ' · n/a ' + (by["n/a"] || 0) +
            ' · ? ' + (by.needs_human || 0) + '</td>' +
          '<td style="font-size:11px;color:#666">' + esc(r.created_at) + '</td>' +
          '</tr>';
      }).join("");
      listEl.innerHTML = '<table class="ads-table" style="width:100%">' +
        '<thead><tr><th>Run</th><th>Target</th><th>Status</th><th>Score</th><th>Checks</th><th>By status</th><th>Created</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    }).catch(function (e) { listEl.innerHTML = '<div class="ads-muted">Failed to load.</div>'; console.warn(e); });
  }

  startBtn.addEventListener("click", function () {
    var t = (target.value || "").trim();
    if (!t) { startStatus.textContent = "Target entity ID required."; return; }
    startBtn.disabled = true;
    startStatus.textContent = "Running…";
    api("/api/diligence/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: tmplSel.value || undefined, target_entity_id: t }),
    }).then(function (summary) {
      startStatus.innerHTML = 'Completed. <a href="/dashboard/diligence/run/?id=' + encodeURIComponent(summary.run_id) + '">Open run</a>';
      loadList();
    }).catch(function (e) {
      startStatus.textContent = "Failed: " + e.message;
    }).finally(function () { startBtn.disabled = false; });
  });

  loadTemplates().then(loadList);
})();
