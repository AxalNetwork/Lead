// Task #2: Crawler Operator Console front-end. Polls /api/ops/crawler/*
// every 10s while the tab is visible; pauses polling when hidden.
(function () {
  var API = "https://api.aidatasignal.com/api/ops/crawler";
  var REFRESH_MS = 10000;
  var timer = null;

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmt(s) { return s ? new Date(s).toLocaleString() : "—"; }
  function ago(s) {
    if (!s) return "—";
    var ms = Date.now() - new Date(s).getTime();
    if (ms < 60000) return Math.round(ms / 1000) + "s ago";
    if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
    if (ms < 86400000) return Math.round(ms / 3600000) + "h ago";
    return Math.round(ms / 86400000) + "d ago";
  }
  function num(v) { return v == null ? 0 : Number(v); }
  function dollars(v) { return "$" + (num(v)).toFixed(4); }

  async function api(path, opts) {
    var r = await fetch(API + path, Object.assign({ credentials: "include" }, opts || {}));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  // ---- renderers ---------------------------------------------------------
  function sparkline(points, key) {
    if (!points || !points.length) return '<div class="ads-empty">No data</div>';
    var W = 720, H = 80, PAD = 4;
    var maxY = 1;
    points.forEach(function (p) { if (num(p[key]) > maxY) maxY = num(p[key]); });
    var dx = (W - PAD * 2) / Math.max(1, points.length - 1);
    var path = "";
    points.forEach(function (p, i) {
      var x = PAD + i * dx;
      var y = H - PAD - (num(p[key]) / maxY) * (H - PAD * 2);
      path += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" '
      + 'style="width:100%;height:auto;display:block">'
      + '<path d="' + path + '" fill="none" stroke="#5b8cff" stroke-width="2"/>'
      + '</svg>';
  }

  async function loadThroughput() {
    var t = await api("/throughput");
    var h = t.last_hour || {};
    $("#ops-kpi-pps").textContent = (h.pages_per_sec || 0).toFixed(3);
    $("#ops-kpi-att").textContent = num(h.attempts).toLocaleString();
    $("#ops-kpi-ok").textContent = num(h.ok).toLocaleString();
    $("#ops-kpi-blk").textContent = num(h.blocked) + " / " + num(h.rate_limited);
    $("#ops-throughput-chart").innerHTML = sparkline(t.hourly || [], "attempts");
  }

  async function loadHosts() {
    var r = await api("/hosts");
    var tbody = $("#ops-hosts tbody");
    if (!r.items || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="ads-empty">No hosts configured yet.</td></tr>';
      return;
    }
    tbody.innerHTML = r.items.map(function (h) {
      var quarantined = h.quarantined_at || h.quarantined_until;
      var qPill = quarantined
        ? '<span class="ads-pill ads-pill--warn">quarantined' + (h.quarantined_until ? ' until ' + esc(h.quarantined_until) : '') + '</span>'
        : '<span class="ads-pill ads-pill--ok">ok</span>';
      return '<tr>'
        + '<td><code class="ads-mono">' + esc(h.host) + '</code></td>'
        + '<td>' + esc(h.recommended_tier) + '</td>'
        + '<td>' + esc(h.max_rps) + '</td>'
        + '<td>' + (h.success_rate_pct == null ? '—' : h.success_rate_pct + '%') + '</td>'
        + '<td>' + num(h.attempts_24h) + '</td>'
        + '<td>' + num(h.r429_24h) + ' / ' + num(h.blocked_24h) + '</td>'
        + '<td>' + (h.robots_cached_at ? ago(h.robots_cached_at) : '—') + '</td>'
        + '<td>' + qPill + '</td>'
        + '<td>' + esc(h.last_error || '') + '</td>'
        + '<td>'
        + '<button class="ads-btn" data-host-action="' + (quarantined ? 'unquarantine' : 'quarantine') + '" data-host="' + esc(h.host) + '">' + (quarantined ? 'Unquarantine' : 'Quarantine') + '</button> '
        + '<button class="ads-btn" data-host-action="set-rps" data-host="' + esc(h.host) + '">Set RPS</button> '
        + '<button class="ads-btn" data-host-action="clear-robots" data-host="' + esc(h.host) + '">Clear robots</button>'
        + '</td></tr>';
    }).join("");
  }

  async function loadFrontier() {
    var f = await api("/frontier");
    var byType = {};
    (f.smart_frontier || []).forEach(function (r) {
      var k = r.profile_type_id || "(none)";
      byType[k] = byType[k] || { queued: 0, enqueued: 0, rejected: 0, crawled: 0 };
      byType[k][r.status] = (byType[k][r.status] || 0) + num(r.n);
    });
    var rows = Object.keys(byType).sort().map(function (k) {
      var v = byType[k];
      return '<tr><td><code class="ads-mono">' + esc(k) + '</code></td>'
        + '<td>' + v.queued + '</td><td>' + v.enqueued + '</td>'
        + '<td>' + v.rejected + '</td><td>' + v.crawled + '</td></tr>';
    }).join("");
    var reasons = (f.by_reason || []).map(function (r) {
      return '<li><code class="ads-mono">' + esc(r.discovery_reason) + '</code> — ' + num(r.n) + '</li>';
    }).join("");
    $("#ops-frontier").innerHTML =
      '<table class="ads-table"><thead><tr><th>Profile type</th><th>queued</th><th>enqueued</th><th>rejected</th><th>crawled</th></tr></thead>'
      + '<tbody>' + (rows || '<tr><td colspan="5" class="ads-empty">Empty</td></tr>') + '</tbody></table>'
      + '<p class="ads-sub" style="margin-top:.5rem">Oldest queued: ' + esc(f.oldest_queued || '—') + '</p>'
      + (reasons ? '<p class="ads-sub" style="margin-top:.5rem"><strong>Top discovery reasons:</strong></p><ul>' + reasons + '</ul>' : '');
  }

  async function loadAiSpend() {
    var s = await api("/ai-spend");
    var daily = (s.daily || []).map(function (d) {
      return '<tr><td>' + esc(d.day) + '</td><td>' + dollars(d.cost_usd) + '</td><td>' + num(d.calls) + '</td></tr>';
    }).join("");
    var purpose = (s.by_purpose || []).map(function (d) {
      return '<tr><td>' + esc(d.purpose) + '</td><td>' + dollars(d.cost_usd) + '</td><td>' + num(d.calls) + '</td></tr>';
    }).join("");
    $("#ops-aispend").innerHTML =
      '<h4 style="margin:.25rem 0">Daily</h4>'
      + '<table class="ads-table"><thead><tr><th>Day</th><th>Cost</th><th>Calls</th></tr></thead>'
      + '<tbody>' + (daily || '<tr><td colspan="3" class="ads-empty">No spend yet</td></tr>') + '</tbody></table>'
      + '<h4 style="margin:.5rem 0 .25rem">By purpose (7d)</h4>'
      + '<table class="ads-table"><thead><tr><th>Purpose</th><th>Cost</th><th>Calls</th></tr></thead>'
      + '<tbody>' + (purpose || '<tr><td colspan="3" class="ads-empty">—</td></tr>') + '</tbody></table>';
  }

  async function loadAdapters() {
    var r = await api("/adapters");
    var tbody = $("#ops-adapters tbody");
    if (!r.items || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="ads-empty">No workflow runs in the last 7 days.</td></tr>';
      return;
    }
    tbody.innerHTML = r.items.map(function (a) {
      var pct = a.parse_success_pct;
      var pill = pct == null ? '—'
        : '<span class="ads-pill ads-pill--' + (pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'err') + '">' + pct + '%</span>';
      return '<tr>'
        + '<td><code class="ads-mono">' + esc(a.profile_type_id) + '</code>'
        + (a.profile_type_label ? ' <span class="ads-sub">' + esc(a.profile_type_label) + '</span>' : '') + '</td>'
        + '<td>' + num(a.runs_7d) + '</td>'
        + '<td>' + pill + ' <span class="ads-sub">' + num(a.success) + 'ok / ' + num(a.partial) + 'p / ' + num(a.failed) + 'f</span></td>'
        + '<td>' + num(a.facts_written) + ' / ' + num(a.facts_verified) + '</td>'
        + '<td>' + num(a.ai_calls) + '</td>'
        + '<td>' + dollars(a.cost_usd) + '</td>'
        + '<td>' + ago(a.last_run_at) + '</td>'
        + '</tr>';
    }).join("");
  }

  async function loadCompliance() {
    var c = await api("/compliance");
    var tbody = $("#ops-compliance tbody");
    var rows = [];
    (c.refusals || []).forEach(function (r) {
      rows.push('<tr><td><span class="ads-pill ads-pill--warn">refusal</span></td><td>' + esc(r.host) + '</td><td>' + esc(r.block_reason) + '</td><td>' + num(r.n) + '</td><td>' + fmt(r.last_at) + '</td></tr>');
    });
    (c.rate_limit_429 || []).forEach(function (r) {
      rows.push('<tr><td><span class="ads-pill ads-pill--warn">429</span></td><td>' + esc(r.host) + '</td><td>HTTP 429</td><td>' + num(r.n) + '</td><td>' + fmt(r.last_at) + '</td></tr>');
    });
    (c.stalest_robots || []).forEach(function (r) {
      rows.push('<tr><td><span class="ads-pill">robots stale</span></td><td>' + esc(r.host) + '</td><td>cached ' + ago(r.robots_cached_at) + '</td><td></td><td>' + fmt(r.robots_cached_at) + '</td></tr>');
    });
    tbody.innerHTML = rows.length ? rows.join("") : '<tr><td colspan="5" class="ads-empty">Clean — no refusals or 429s in the last 24h.</td></tr>';
  }

  async function loadSeeds() {
    var r = await api("/seeds");
    var tbody = $("#ops-seeds tbody");
    if (!r.items || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="ads-empty">No seeds configured.</td></tr>';
      return;
    }
    tbody.innerHTML = r.items.map(function (s) {
      return '<tr>'
        + '<td><code class="ads-mono">' + esc(s.profile_type_id) + '</code>'
        + (s.profile_type_label ? ' <span class="ads-sub">' + esc(s.profile_type_label) + '</span>' : '') + '</td>'
        + '<td>' + esc(s.seed_kind) + '</td>'
        + '<td><code class="ads-mono" style="word-break:break-all">' + esc(s.value) + '</code></td>'
        + '<td>' + (s.enabled ? '✓' : '—') + '</td>'
        + '<td>' + ago(s.last_crawled_at) + '</td>'
        + '<td>' + num(s.success_count) + '</td>'
        + '<td>' + num(s.entity_count) + '</td>'
        + '</tr>';
    }).join("");
  }

  async function loadExtractions() {
    var r = await api("/extractions?limit=50");
    var tbody = $("#ops-extractions tbody");
    if (!r.items || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="ads-empty">No extractions yet.</td></tr>';
      return;
    }
    tbody.innerHTML = r.items.map(function (e) {
      return '<tr>'
        + '<td>' + ago(e.run_at) + '</td>'
        + '<td><a href="' + esc(e.candidate_url) + '" target="_blank" rel="noopener"><code class="ads-mono" style="word-break:break-all">' + esc(e.candidate_url) + '</code></a></td>'
        + '<td>' + esc(e.profile_type_label || e.profile_type_id || '') + '</td>'
        + '<td><span class="ads-pill ads-pill--' + (e.status === 'success' ? 'ok' : e.status === 'failed' ? 'err' : 'warn') + '">' + esc(e.status) + '</span></td>'
        + '<td>' + num(e.facts_written) + '/' + num(e.facts_verified) + '</td>'
        + '<td>' + dollars(e.actual_cost_usd) + '</td>'
        + '<td>' + num(e.duration_ms) + 'ms</td>'
        + '<td>' + (e.entity_id ? '<button class="ads-btn" data-recrawl="' + esc(e.entity_id) + '">Recrawl</button>' : '') + '</td>'
        + '</tr>';
    }).join("");
  }

  async function loadAudit() {
    var r = await api("/audit?limit=50");
    var tbody = $("#ops-audit tbody");
    if (!r.items || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="ads-empty">No audit entries.</td></tr>';
      return;
    }
    tbody.innerHTML = r.items.map(function (a) {
      return '<tr>'
        + '<td>' + fmt(a.created_at) + '</td>'
        + '<td>' + esc(a.actor_email) + '</td>'
        + '<td><code class="ads-mono">' + esc(a.action) + '</code></td>'
        + '<td>' + esc((a.target_kind || '') + (a.target_id ? ':' + a.target_id : '')) + '</td>'
        + '<td><code class="ads-mono" style="font-size:.8em">' + esc(a.payload_json || '') + '</code></td>'
        + '</tr>';
    }).join("");
  }

  async function loadPauseState() {
    try {
      var r = await api("/pause-status");
      var el = $("#ops-pause-state");
      el.textContent = r.paused ? "PAUSED" : "running";
      el.className = "ads-pill " + (r.paused ? "ads-pill--err" : "ads-pill--ok");
    } catch (e) { /* ignore */ }
  }

  async function refreshAll() {
    var stamp = new Date().toLocaleTimeString();
    $("#ops-last-refresh").textContent = "last refresh " + stamp;
    var jobs = [loadPauseState(), loadThroughput(), loadHosts(), loadFrontier(),
                loadAiSpend(), loadAdapters(), loadCompliance(), loadSeeds(),
                loadExtractions(), loadAudit()];
    await Promise.allSettled(jobs);
  }

  // ---- event wiring ------------------------------------------------------
  document.addEventListener("click", async function (e) {
    var t = e.target;
    if (!t || t.tagName !== "BUTTON") return;
    try {
      if (t.dataset.action === "refresh")  { await refreshAll(); return; }
      if (t.dataset.action === "pause")    {
        var reason = prompt("Reason for pausing the crawler? (optional)") || "";
        await post("/pause", { reason: reason }); await refreshAll(); return;
      }
      if (t.dataset.action === "resume")   { await post("/resume", {}); await refreshAll(); return; }
      if (t.dataset.recrawl) {
        await post("/recrawl-entity", { entity_id: t.dataset.recrawl, reason: "operator console" });
        t.textContent = "queued"; t.disabled = true; return;
      }
      if (t.dataset.hostAction) {
        var host = t.dataset.host;
        if (t.dataset.hostAction === "quarantine") {
          var until = prompt("Quarantine until (ISO timestamp, blank = indefinite):", "") || null;
          var reason2 = prompt("Reason?", "") || null;
          await post("/hosts/" + encodeURIComponent(host) + "/quarantine", { until: until, reason: reason2 });
        } else if (t.dataset.hostAction === "unquarantine") {
          await post("/hosts/" + encodeURIComponent(host) + "/unquarantine", {});
        } else if (t.dataset.hostAction === "set-rps") {
          var rpsStr = prompt("Max requests per second for " + host + ":", "0.5");
          if (rpsStr == null) return;
          await post("/hosts/" + encodeURIComponent(host) + "/rps", { max_rps: Number(rpsStr) });
        } else if (t.dataset.hostAction === "clear-robots") {
          await post("/hosts/" + encodeURIComponent(host) + "/clear-robots", {});
        }
        await loadHosts(); await loadAudit();
      }
    } catch (err) { alert("Action failed: " + err.message); }
  });

  var testForm = document.getElementById("ops-test-url-form");
  if (testForm) {
    testForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var url = testForm.elements.url.value.trim();
      if (!url) return;
      var out = $("#ops-test-url-result");
      out.textContent = "Fetching…";
      try {
        var r = await post("/test-url", { url: url });
        out.textContent = JSON.stringify(r, null, 2);
        loadAudit();
      } catch (err) { out.textContent = "Error: " + err.message; }
    });
  }

  function start() {
    if (timer) return;
    refreshAll();
    timer = setInterval(refreshAll, REFRESH_MS);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else start();
  });
  start();
})();
