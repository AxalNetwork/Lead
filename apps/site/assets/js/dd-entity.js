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

  function getEntityId() {
    var m = /[?&]entity=(\d+)/.exec(window.location.search);
    return m ? Number(m[1]) : null;
  }

  function getRefParams() {
    var qs = window.location.search;
    var t = /[?&]table=([^&]+)/.exec(qs);
    var r = /[?&]ref=([^&]+)/.exec(qs);
    return t && r ? { table: decodeURIComponent(t[1]), ref: decodeURIComponent(r[1]) } : null;
  }

  // Resolve (table, ref) -> entity_id by hitting /api/dd/scores/by-ref.
  // When no entity row exists yet we surface a helpful message instead of
  // a 404 spinner so the operator knows to seed the entity first.
  async function resolveRef(ref) {
    var j = await api('/api/dd/scores/by-ref?table=' + encodeURIComponent(ref.table)
      + '&ids=' + encodeURIComponent(ref.ref));
    var hit = j && j.items && j.items[ref.ref];
    return hit ? hit.entity_id : null;
  }

  function renderScore(s) {
    if (!s) return '<div class="ads-muted">Not scanned yet.</div>';
    var comp = (function () { try { return JSON.parse(s.components_json || '{}'); } catch (e) { return {}; } })();
    var compHtml = Object.keys(comp).map(function (k) {
      return '<div class="ads-kv"><span class="ads-muted">' + esc(k) + '</span> <strong>' + Number(comp[k]).toFixed(1) + '</strong></div>';
    }).join('');
    return ''
      + '<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">'
      +   '<div><div class="ads-muted" style="font-size:11px">Risk band</div><div><span class="' + bandClass(s.risk_band) + '" style="font-size:14px;padding:6px 12px">' + esc(s.risk_band.toUpperCase()) + '</span></div></div>'
      +   '<div><div class="ads-muted" style="font-size:11px">Risk score</div><div style="font-size:24px;font-weight:600">' + Number(s.risk_score).toFixed(1) + '</div></div>'
      +   '<div><div class="ads-muted" style="font-size:11px">Trust score</div><div style="font-size:24px;font-weight:600">' + Number(s.trust_score).toFixed(1) + '</div></div>'
      +   '<div><div class="ads-muted" style="font-size:11px">Last scan</div><div>' + esc(s.last_scan_at || '–') + '</div></div>'
      + '</div>'
      + '<div style="margin-top:12px;display:flex;gap:14px;flex-wrap:wrap">' + compHtml + '</div>';
  }

  async function loadScore(id) {
    try {
      var s = await api('/api/dd/scores/' + id);
      $("ads-dd-title").textContent = (s.entity_name || ('Entity #' + id)) + ' — DD';
      $("ads-dd-sub").textContent = (s.entity_kind || 'entity') + ' • last scanned ' + (s.last_scan_at || 'never');
      $("ads-dd-e-score").innerHTML = renderScore(s);
      $("ads-dd-e-summary").textContent = s.ai_summary || '';
      $("ads-dd-e-meta").textContent = 'scan id: ' + (s.last_scan_id || '–');
    } catch (e) {
      if (String(e.message) === 'http_404') {
        $("ads-dd-e-score").innerHTML = '<div class="ads-muted">Not scanned yet. Click "Run scan now" to populate.</div>';
      } else {
        $("ads-dd-e-score").innerHTML = '<div class="ads-error">' + esc(e.message) + '</div>';
      }
    }
  }

  async function loadFindings(id) {
    var c = $("ads-dd-e-findings");
    try {
      var j = await api('/api/dd/findings?entity=' + id + '&limit=200');
      var items = j.items || [];
      $("ads-dd-e-fcount").textContent = items.length + ' total';
      if (!items.length) { c.innerHTML = '<div class="ads-muted">No findings yet.</div>'; return; }
      var rows = items.map(function (f) {
        return '<tr>'
          + '<td><span class="' + sevClass(f.severity) + '">' + esc(f.severity) + '</span></td>'
          + '<td>' + esc(f.finding_type) + (f.finding_subtype ? ' <span class="ads-muted">(' + esc(f.finding_subtype) + ')</span>' : '') + '</td>'
          + '<td>' + esc(f.title) + (f.description ? '<br><span class="ads-muted" style="font-size:12px">' + esc(f.description).slice(0, 200) + '</span>' : '') + '</td>'
          + '<td><span class="ads-muted">' + esc(f.source_provider) + '</span>' + (f.source_url && /^https?:/.test(f.source_url) ? ' • <a href="' + esc(f.source_url) + '" target="_blank" rel="noopener">src</a>' : '') + '</td>'
          + '<td>' + (f.match_score != null ? Number(f.match_score).toFixed(2) : '–') + '</td>'
          + '<td>' + esc(f.status) + '</td>'
          + '<td>'
          +   '<button class="ads-btn ads-btn--ghost" data-action="confirmed" data-id="' + f.id + '">Confirm</button> '
          +   '<button class="ads-btn ads-btn--ghost" data-action="false_positive" data-id="' + f.id + '">FP</button> '
          +   '<button class="ads-btn ads-btn--ghost" data-action="resolved" data-id="' + f.id + '">Resolve</button>'
          + '</td>'
          + '</tr>';
      }).join('');
      c.innerHTML = '<table class="ads-table"><thead><tr>'
        + '<th>Sev</th><th>Type</th><th>Title</th><th>Source</th><th>Match</th><th>Status</th><th>Actions</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
      c.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var fid = btn.getAttribute('data-id');
          var action = btn.getAttribute('data-action');
          api('/api/dd/findings/' + fid, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: action }),
          }).then(function () { loadScore(id); loadFindings(id); })
            .catch(function (e) { alert('Update failed: ' + e.message); });
        });
      });
    } catch (e) {
      c.innerHTML = '<div class="ads-error">' + esc(e.message) + '</div>';
    }
  }

  async function loadRuns(id) {
    var c = $("ads-dd-e-runs");
    try {
      var j = await api('/api/dd/scan-runs?entity=' + id + '&limit=20');
      var items = j.items || [];
      if (!items.length) { c.innerHTML = '<div class="ads-muted">No scans yet.</div>'; return; }
      var rows = items.map(function (r) {
        return '<tr>'
          + '<td>' + esc(r.started_at) + '</td>'
          + '<td>' + esc(r.trigger) + (r.triggered_by ? ' <span class="ads-muted">(' + esc(r.triggered_by) + ')</span>' : '') + '</td>'
          + '<td>' + esc(r.status) + '</td>'
          + '<td>' + (r.findings_added || 0) + ' added / ' + (r.findings_resolved || 0) + ' resolved</td>'
          + '<td>' + (r.duration_ms || 0) + ' ms</td>'
          + '<td><span class="ads-muted">' + esc(r.providers_attempted_json || '') + '</span></td>'
          + '</tr>';
      }).join('');
      c.innerHTML = '<table class="ads-table"><thead><tr>'
        + '<th>Started</th><th>Trigger</th><th>Status</th><th>Findings</th><th>Took</th><th>Providers</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
    } catch (e) {
      c.innerHTML = '<div class="ads-error">' + esc(e.message) + '</div>';
    }
  }

  function runScan(id, dispatch) {
    var btn = dispatch ? $("ads-dd-e-dispatch") : $("ads-dd-e-scan");
    var msg = $("ads-dd-e-msg");
    btn.disabled = true;
    msg.textContent = dispatch ? 'Dispatching workflow…' : 'Running scan (this can take 20–60 seconds)…';
    var url = '/api/dd/scan/' + id + (dispatch ? '/dispatch' : '');
    api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) {
        msg.textContent = 'Done: ' + JSON.stringify(r);
        loadScore(id); loadFindings(id); loadRuns(id);
      })
      .catch(function (e) { msg.textContent = 'Failed: ' + e.message; })
      .finally(function () { btn.disabled = false; });
  }

  function startWith(id) {
    loadScore(id);
    loadFindings(id);
    loadRuns(id);
    $("ads-dd-e-scan").addEventListener("click", function () { runScan(id, false); });
    $("ads-dd-e-dispatch").addEventListener("click", function () { runScan(id, true); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var id = getEntityId();
    if (id) { startWith(id); return; }
    var ref = getRefParams();
    if (ref) {
      $("ads-dd-e-score").innerHTML = '<div class="ads-loading">Resolving entity…</div>';
      resolveRef(ref).then(function (resolved) {
        if (resolved) { startWith(resolved); return; }
        $("ads-dd-e-score").innerHTML = '<div class="ads-muted">No entity row exists yet for '
          + esc(ref.table) + ' #' + esc(ref.ref) + '. Run a derive pass to create one, then return here.</div>';
      }).catch(function (e) {
        $("ads-dd-e-score").innerHTML = '<div class="ads-error">' + esc(e.message) + '</div>';
      });
      return;
    }
    $("ads-dd-e-score").innerHTML = '<div class="ads-muted">Add <code>?entity=&lt;id&gt;</code> or <code>?table=firms&amp;ref=&lt;id&gt;</code> to the URL.</div>';
  });
})();
