(function () {
  "use strict";
  var API = window.ADS_API_BASE || "https://api.aidatasignal.com";
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function bandClass(b) {
    return {
      critical: "ads-tag ads-tag--danger",
      high: "ads-tag ads-tag--warn",
      medium: "ads-tag",
      low: "ads-tag ads-tag--ok",
      unknown: "ads-tag ads-tag--muted",
    }[b] || "ads-tag";
  }

  function sevClass(s) {
    return {
      critical: "ads-tag ads-tag--danger",
      high: "ads-tag ads-tag--warn",
      medium: "ads-tag",
      low: "ads-tag ads-tag--muted",
    }[s] || "ads-tag";
  }

  async function api(path, opts) {
    var r = await fetch(API + path, Object.assign({ credentials: "include" }, opts || {}));
    if (!r.ok) throw new Error("http_" + r.status);
    return r.json();
  }

  async function loadBands() {
    try {
      var bands = ["critical", "high", "medium", "low"];
      var results = await Promise.all(bands.map(function (b) {
        return api("/api/dd/scores?band=" + b + "&limit=1").then(function (j) {
          return { band: b, count: (j.items || []).length };
        }).catch(function () { return { band: b, count: 0 }; });
      }));
      // We don't have a count endpoint; show a one-row sample per band so operators see availability.
      // For real counts call the scores endpoint with larger limits.
      var html = results.map(function (r) {
        return '<span class="' + bandClass(r.band) + '" style="padding:6px 12px;font-size:12px">'
          + esc(r.band.toUpperCase()) + (r.count ? " ✓" : " ·") + '</span>';
      }).join("");
      $("ads-dd-bands").innerHTML = html;
    } catch (e) {
      $("ads-dd-bands").innerHTML = '<div class="ads-error">' + esc(e.message) + '</div>';
    }
  }

  async function loadQueue() {
    var q = $("ads-dd-queue");
    q.innerHTML = '<div class="ads-loading">Loading…</div>';
    try {
      var type = $("ads-dd-filter-type").value;
      var sev = $("ads-dd-filter-sev").value;
      var status = $("ads-dd-filter-status").value;
      var path = "/api/dd/findings?limit=200";
      if (type) path += "&type=" + encodeURIComponent(type);
      if (sev) path += "&severity=" + encodeURIComponent(sev);
      if (status) path += "&status=" + encodeURIComponent(status);
      var j = await api(path);
      var items = j.items || [];
      if (!items.length) { q.innerHTML = '<div class="ads-muted">No findings.</div>'; return; }
      var rows = items.map(function (f) {
        var actions = '<button class="ads-btn ads-btn--ghost" data-action="confirmed" data-id="' + f.id + '">Confirm</button>'
          + ' <button class="ads-btn ads-btn--ghost" data-action="false_positive" data-id="' + f.id + '">False positive</button>'
          + ' <button class="ads-btn ads-btn--ghost" data-action="resolved" data-id="' + f.id + '">Resolve</button>';
        return '<tr>'
          + '<td><span class="' + sevClass(f.severity) + '">' + esc(f.severity) + '</span></td>'
          + '<td>' + esc(f.finding_type) + (f.finding_subtype ? ' <span class="ads-muted">(' + esc(f.finding_subtype) + ')</span>' : '') + '</td>'
          + '<td><a href="/dashboard/dd-entity/?entity=' + f.entity_id + '">#' + f.entity_id + '</a></td>'
          + '<td>' + esc(f.title) + '</td>'
          + '<td><span class="ads-muted">' + esc(f.source_provider) + '</span>' + (f.source_url && /^https?:\/\//i.test(f.source_url) ? ' • <a href="' + esc(f.source_url) + '" target="_blank" rel="noopener">src</a>' : '') + '</td>'
          + '<td>' + (f.match_score != null ? Number(f.match_score).toFixed(2) : '–') + '</td>'
          + '<td>' + esc(f.status) + '</td>'
          + '<td>' + actions + '</td>'
          + '</tr>';
      }).join("");
      q.innerHTML = '<table class="ads-table"><thead><tr>'
        + '<th>Sev</th><th>Type</th><th>Entity</th><th>Title</th><th>Source</th><th>Match</th><th>Status</th><th>Actions</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
      q.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          var action = btn.getAttribute('data-action');
          api('/api/dd/findings/' + id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: action }),
          }).then(loadQueue).catch(function (e) { alert('Update failed: ' + e.message); });
        });
      });
    } catch (e) {
      q.innerHTML = '<div class="ads-error">' + esc(e.message) + '</div>';
    }
  }

  async function loadScores() {
    var c = $("ads-dd-scores");
    try {
      var j = await api("/api/dd/scores?limit=50");
      var items = j.items || [];
      if (!items.length) { c.innerHTML = '<div class="ads-muted">No scored entities yet. Run a scan to populate.</div>'; return; }
      var rows = items.map(function (r) {
        return '<tr>'
          + '<td><a href="/dashboard/dd-entity/?entity=' + r.entity_id + '">' + esc(r.entity_name || ('#' + r.entity_id)) + '</a></td>'
          + '<td><span class="ads-muted">' + esc(r.entity_kind || '') + '</span></td>'
          + '<td><span class="' + bandClass(r.risk_band) + '">' + esc(r.risk_band) + '</span></td>'
          + '<td>' + Number(r.risk_score).toFixed(1) + '</td>'
          + '<td>' + Number(r.trust_score).toFixed(1) + '</td>'
          + '<td>' + (r.sanctions_count || 0) + '</td>'
          + '<td>' + (r.adverse_media_count || 0) + '</td>'
          + '<td>' + (r.enforcement_count || 0) + '</td>'
          + '<td><span class="ads-muted">' + esc(r.last_scan_at || '') + '</span></td>'
          + '</tr>';
      }).join("");
      c.innerHTML = '<table class="ads-table"><thead><tr>'
        + '<th>Entity</th><th>Kind</th><th>Band</th><th>Risk</th><th>Trust</th>'
        + '<th>Sanc.</th><th>Media</th><th>Enf.</th><th>Last scan</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
    } catch (e) {
      c.innerHTML = '<div class="ads-error">' + esc(e.message) + '</div>';
    }
  }

  async function loadWatchlists() {
    var c = $("ads-dd-watchlists");
    try {
      var j = await api("/api/dd/watchlist-cache");
      var items = j.items || [];
      if (!items.length) { c.innerHTML = '<div class="ads-muted">No snapshots yet. Click "Force refresh".</div>'; return; }
      var rows = items.map(function (r) {
        return '<tr>'
          + '<td>' + esc(r.provider) + '</td>'
          + '<td>' + esc(r.list_name) + '</td>'
          + '<td>' + esc(r.snapshot_date) + '</td>'
          + '<td>' + (r.record_count || 0).toLocaleString() + '</td>'
          + '<td>' + (r.ok ? '<span class="ads-tag ads-tag--ok">OK</span>' : '<span class="ads-tag ads-tag--danger">FAIL</span>') + '</td>'
          + '<td><span class="ads-muted">' + esc(r.fetched_at) + '</span></td>'
          + '<td>' + (r.duration_ms || 0) + ' ms</td>'
          + '</tr>';
      }).join("");
      c.innerHTML = '<table class="ads-table"><thead><tr>'
        + '<th>Provider</th><th>List</th><th>Snapshot</th><th>Records</th><th>Status</th><th>Fetched</th><th>Took</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
    } catch (e) {
      c.innerHTML = '<div class="ads-error">' + esc(e.message) + '</div>';
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    loadBands();
    loadQueue();
    loadScores();
    loadWatchlists();
    $("ads-dd-refresh").addEventListener("click", loadQueue);
    $("ads-dd-filter-type").addEventListener("change", loadQueue);
    $("ads-dd-filter-sev").addEventListener("change", loadQueue);
    $("ads-dd-filter-status").addEventListener("change", loadQueue);
    $("ads-dd-batch").addEventListener("click", function () {
      $("ads-dd-batch").disabled = true;
      api("/api/dd/scan/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 50 }) })
        .then(function (r) { alert("Batch scan dispatched: " + JSON.stringify(r)); loadScores(); })
        .catch(function (e) { alert("Batch failed: " + e.message); })
        .finally(function () { $("ads-dd-batch").disabled = false; });
    });
    $("ads-dd-wl-refresh").addEventListener("click", function () {
      $("ads-dd-wl-refresh").disabled = true;
      api("/api/dd/watchlist-refresh", { method: "POST" })
        .then(function () { loadWatchlists(); })
        .catch(function (e) { alert("Refresh failed: " + e.message); })
        .finally(function () { $("ads-dd-wl-refresh").disabled = false; });
    });
  });
})();
