// Task #2: Crawler Operator Console front-end. Polls /api/ops/crawler/*
// every 10s while the tab is visible; pauses when hidden. Performs a
// pre-flight against /api/ops/crawler/ on load and replaces the page
// with a 403 message if the caller is not on the ops admin allowlist.
(function () {
  var API = "https://api.aidatasignal.com/api/ops/crawler";
  var REFRESH_MS = 10000;
  var timer = null;
  var hostFilter = { q: "", status: "" };
  var aiSpendWindow = "day";

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
    if (r.status === 403) { showForbidden(); throw new Error("forbidden"); }
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

  function showForbidden() {
    var f = document.getElementById("ops-forbidden");
    if (f) f.style.display = "block";
    var sections = document.querySelectorAll("#ops-root > .ads-card:not(#ops-forbidden), #ops-root > h2, #ops-root > .ads-grid");
    sections.forEach(function (el) { el.style.display = "none"; });
    stop();
  }

  // ---- chart helpers -----------------------------------------------------
  function stackedAreaByTier(buckets) {
    if (!buckets || !buckets.length) return '<div class="ads-empty">No data</div>';
    var bucketSet = {}, tierSet = {};
    buckets.forEach(function (b) {
      bucketSet[b.bucket] = true; tierSet[b.tier] = true;
    });
    var bucketList = Object.keys(bucketSet).sort();
    var tierList = Object.keys(tierSet).sort();
    var key = function (b, t) { return b + "|" + t; };
    var data = {};
    buckets.forEach(function (b) { data[key(b.bucket, b.tier)] = num(b.attempts); });
    var W = 720, H = 140, PAD = 24;
    var maxY = 1;
    bucketList.forEach(function (b) {
      var s = 0; tierList.forEach(function (t) { s += data[key(b, t)] || 0; });
      if (s > maxY) maxY = s;
    });
    var colors = ["#5b8cff", "#23d6a4", "#f0b400", "#e36a6a", "#a06bff", "#888"];
    var dx = (W - PAD * 2) / Math.max(1, bucketList.length - 1);
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">';
    svg += '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" stroke="#243066"/>';
    var prev = bucketList.map(function () { return H - PAD; });
    tierList.forEach(function (t, ti) {
      var pts = [];
      var bottom = prev.slice();
      bucketList.forEach(function (b, i) {
        var v = data[key(b, t)] || 0;
        var x = PAD + i * dx;
        var y = bottom[i] - (v / maxY) * (H - PAD * 2);
        pts.push([x, y]);
        prev[i] = y;
      });
      var path = pts.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join("");
      for (var i = bucketList.length - 1; i >= 0; i--) {
        path += "L" + (PAD + i * dx).toFixed(1) + "," + bottom[i].toFixed(1);
      }
      path += "Z";
      svg += '<path d="' + path + '" fill="' + colors[ti % colors.length] + '" fill-opacity=".75" stroke="none"><title>tier ' + t + '</title></path>';
    });
    svg += '</svg>';
    var legend = tierList.map(function (t, ti) {
      return '<span style="display:inline-block;width:10px;height:10px;background:' + colors[ti % colors.length] + ';margin-right:.25rem"></span>tier ' + esc(t);
    }).join(" &nbsp; ");
    return svg + '<p class="ads-sub" style="margin:.25rem 0">' + legend + '</p>';
  }

  // ---- renderers ---------------------------------------------------------
  async function loadDriftBanner() {
    try {
      var r = await api("/drift-alerts");
      var el = $("#ops-drift-banner");
      if (!r.items || !r.items.length) { el.innerHTML = ""; return; }
      el.innerHTML = '<div class="ads-card ads-card--warn" style="margin-bottom:.75rem"><strong>⚠ Drift detected.</strong> '
        + r.items.length + ' profile type(s) had a >=30pp parse-success drop in the last 14 days. '
        + '<details style="display:inline"><summary>Details</summary><ul>'
        + r.items.slice(0, 10).map(function (a) {
            var p = {}; try { p = JSON.parse(a.payload_json || "{}"); } catch (e) {}
            return '<li><code>' + esc(a.profile_type_id) + '</code> — drop ' + esc(p.drop_pp) + 'pp ('
              + esc(p.prior_success_rate) + ' → ' + esc(p.recent_success_rate) + ') at ' + fmt(a.created_at) + '</li>';
          }).join("")
        + '</ul></details></div>';
    } catch (e) { /* ignore */ }
  }

  async function loadThroughput() {
    var t = await api("/throughput");
    var h = t.last_hour || {};
    $("#ops-kpi-pps").textContent = (h.pages_per_sec || 0).toFixed(3);
    $("#ops-kpi-att").textContent = num(h.attempts).toLocaleString();
    $("#ops-kpi-sr").textContent = h.success_rate_pct == null ? "—" : h.success_rate_pct + "%";
    $("#ops-kpi-blk").textContent = num(h.blocked) + " / " + num(h.rate_limited);
    $("#ops-throughput-chart").innerHTML = stackedAreaByTier(t.minutely || []);
    var tbody = $("#ops-tier-stats tbody");
    if (!t.tier_stats || !t.tier_stats.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="ads-empty">No fetches in the last hour.</td></tr>';
    } else {
      tbody.innerHTML = t.tier_stats.map(function (s) {
        return '<tr><td>' + s.tier + '</td><td>' + s.samples + '</td><td>' + s.p50 + '</td><td>' + s.p95 + '</td></tr>';
      }).join("");
    }
  }

  async function loadHosts() {
    var qs = [];
    if (hostFilter.q) qs.push("q=" + encodeURIComponent(hostFilter.q));
    if (hostFilter.status) qs.push("status=" + encodeURIComponent(hostFilter.status));
    var r = await api("/hosts" + (qs.length ? "?" + qs.join("&") : ""));
    var tbody = $("#ops-hosts tbody");
    if (!r.items || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="ads-empty">No hosts match.</td></tr>';
      return;
    }
    tbody.innerHTML = r.items.map(function (h) {
      var quarantined = h.quarantined_at || h.quarantined_until;
      var statePill = h.whitelisted
        ? '<span class="ads-pill ads-pill--ok">whitelisted</span>'
        : quarantined
        ? '<span class="ads-pill ads-pill--warn">quarantined' + (h.quarantined_until ? ' until ' + esc(h.quarantined_until) : '') + '</span>'
        : '<span class="ads-pill">normal</span>';
      return '<tr>'
        + '<td><code class="ads-mono">' + esc(h.host) + '</code></td>'
        + '<td>' + esc(h.recommended_tier) + '</td>'
        + '<td>' + esc(h.max_rps) + '</td>'
        + '<td>' + (h.success_rate_pct == null ? '—' : h.success_rate_pct + '%') + '</td>'
        + '<td>' + num(h.attempts_24h) + '</td>'
        + '<td>' + num(h.r429_24h) + ' / ' + num(h.blocked_24h) + '</td>'
        + '<td>' + (h.robots_cached_at ? ago(h.robots_cached_at) : '—') + '</td>'
        + '<td>' + statePill + '</td>'
        + '<td>' + esc(h.last_error || '') + '</td>'
        + '<td>'
        + '<button class="ads-btn" data-host-action="test" data-host="' + esc(h.host) + '">Test fetch</button> '
        + '<button class="ads-btn" data-host-action="set-rps" data-host="' + esc(h.host) + '">Lower RPS</button> '
        + '<button class="ads-btn" data-host-action="' + (quarantined ? 'unquarantine' : 'quarantine') + '" data-host="' + esc(h.host) + '">' + (quarantined ? 'Unquarantine' : 'Quarantine') + '</button> '
        + '<button class="ads-btn" data-host-action="whitelist" data-host="' + esc(h.host) + '">Whitelist</button> '
        + '<button class="ads-btn" data-host-action="clear-robots" data-host="' + esc(h.host) + '">Clear robots</button> '
        + '<button class="ads-btn" data-host-action="pause-host" data-host="' + esc(h.host) + '">Pause host</button>'
        + '</td></tr>';
    }).join("");
  }

  async function loadFrontier() {
    var f = await api("/frontier");
    // By reason — bar chart-ish table
    var rmax = 1;
    (f.by_reason || []).forEach(function (r) { if (num(r.pending) > rmax) rmax = num(r.pending); });
    var reasons = (f.by_reason || []).map(function (r) {
      var pctW = Math.round((num(r.pending) / rmax) * 100);
      return '<tr><td><code class="ads-mono">' + esc(r.discovery_reason) + '</code></td>'
        + '<td>' + num(r.pending) + '</td>'
        + '<td>' + (r.oldest ? ago(r.oldest) : '—') + '</td>'
        + '<td><div style="background:#5b8cff;height:8px;width:' + pctW + '%"></div></td></tr>';
    }).join("");
    $("#ops-frontier-reasons").innerHTML =
      '<table class="ads-table"><thead><tr><th>Reason</th><th>Pending</th><th>Oldest</th><th>Bar</th></tr></thead>'
      + '<tbody>' + (reasons || '<tr><td colspan="4" class="ads-empty">Frontier empty</td></tr>') + '</tbody></table>'
      + '<p class="ads-sub" style="margin-top:.5rem">Oldest queued overall: ' + esc(f.oldest_queued || '—') + '</p>';

    var byType = {};
    (f.smart_frontier || []).forEach(function (r) {
      var k = r.profile_type_id || "(none)";
      byType[k] = byType[k] || { queued: 0, enqueued: 0, rejected: 0, crawled: 0 };
      byType[k][r.status] = (byType[k][r.status] || 0) + num(r.n);
    });
    var rows = Object.keys(byType).sort().map(function (k) {
      var v = byType[k];
      return '<tr><td><code class="ads-mono">' + esc(k) + '</code> '
        + '<button class="ads-btn" data-action="pause-type" data-type="' + esc(k) + '" style="font-size:.7em">Pause</button></td>'
        + '<td>' + v.queued + '</td><td>' + v.enqueued + '</td>'
        + '<td>' + v.rejected + '</td><td>' + v.crawled + '</td></tr>';
    }).join("");
    $("#ops-frontier-types").innerHTML =
      '<table class="ads-table"><thead><tr><th>Profile type</th><th>queued</th><th>enqueued</th><th>rejected</th><th>crawled</th></tr></thead>'
      + '<tbody>' + (rows || '<tr><td colspan="5" class="ads-empty">Empty</td></tr>') + '</tbody></table>';
  }

  async function loadAiSpend() {
    var s = await api("/ai-spend?window=" + encodeURIComponent(aiSpendWindow));
    var tot = s.total || {};
    $("#ops-aispend-total").textContent = "Total: " + dollars(tot.cost_usd)
      + " · " + num(tot.calls).toLocaleString() + " calls · "
      + num(tot.neurons).toLocaleString() + " neurons";
    var purpose = (s.by_purpose || []).map(function (d) {
      return '<tr><td>' + esc(d.purpose) + '</td><td>' + dollars(d.cost_usd) + '</td><td>' + num(d.calls) + '</td><td>' + num(d.neurons) + '</td></tr>';
    }).join("");
    var byType = (s.by_profile_type || []).map(function (d) {
      return '<tr><td><code class="ads-mono">' + esc(d.profile_type_id) + '</code>'
        + (d.profile_type_label ? ' <span class="ads-sub">' + esc(d.profile_type_label) + '</span>' : '') + '</td>'
        + '<td>' + dollars(d.cost_usd) + '</td><td>' + num(d.ai_calls) + '</td><td>' + num(d.neurons) + '</td></tr>';
    }).join("");
    var daily = (s.daily || []).map(function (d) {
      return '<tr><td>' + esc(d.day) + '</td><td>' + dollars(d.cost_usd) + '</td><td>' + num(d.calls) + '</td></tr>';
    }).join("");
    $("#ops-aispend").innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">'
      + '<div><h4 style="margin:.25rem 0">By purpose</h4>'
      + '<table class="ads-table"><thead><tr><th>Purpose</th><th>Cost</th><th>Calls</th><th>Neurons</th></tr></thead>'
      + '<tbody>' + (purpose || '<tr><td colspan="4" class="ads-empty">—</td></tr>') + '</tbody></table></div>'
      + '<div><h4 style="margin:.25rem 0">By per-type workflow</h4>'
      + '<table class="ads-table"><thead><tr><th>Type</th><th>Cost</th><th>Calls</th><th>Neurons</th></tr></thead>'
      + '<tbody>' + (byType || '<tr><td colspan="4" class="ads-empty">No per-type workflow runs in this window</td></tr>') + '</tbody></table></div>'
      + '</div>'
      + '<h4 style="margin-top:1rem">Daily (30d)</h4>'
      + '<table class="ads-table"><thead><tr><th>Day</th><th>Cost</th><th>Calls</th></tr></thead>'
      + '<tbody>' + (daily || '<tr><td colspan="3" class="ads-empty">No spend yet</td></tr>') + '</tbody></table>';
  }

  async function loadAdapters() {
    var r = await api("/adapters");
    var tbody = $("#ops-adapters tbody");
    if (!r.items || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="ads-empty">No workflow runs in the last 7 days.</td></tr>';
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
        + '<td>' + (a.last_drift_at ? '<span class="ads-pill ads-pill--warn">' + ago(a.last_drift_at) + '</span>' : '—') + '</td>'
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
      tbody.innerHTML = '<tr><td colspan="5" class="ads-empty">No seeds configured.</td></tr>';
      return;
    }
    tbody.innerHTML = r.items.map(function (s) {
      return '<tr>'
        + '<td><code class="ads-mono">' + esc(s.profile_type_id) + '</code>'
        + (s.profile_type_label ? ' <span class="ads-sub">' + esc(s.profile_type_label) + '</span>' : '') + '</td>'
        + '<td>' + num(s.seeds_enabled) + ' / ' + num(s.seeds_total) + '</td>'
        + '<td>' + ago(s.last_crawled_at) + '</td>'
        + '<td>' + num(s.entities_discovered) + '</td>'
        + '<td>' + (s.success_ratio == null ? '—' : s.success_ratio) + '</td>'
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
        + '<td>' + (e.confidence == null ? '—' : e.confidence) + '</td>'
        + '<td><span class="ads-pill ads-pill--' + (e.status === 'success' ? 'ok' : e.status === 'failed' ? 'err' : 'warn') + '">' + esc(e.status) + '</span></td>'
        + '<td>' + num(e.facts_written) + '/' + num(e.facts_verified) + '</td>'
        + '<td>' + dollars(e.actual_cost_usd) + '</td>'
        + '<td>'
        + '<button class="ads-btn" data-replay="' + esc(e.id) + '">Replay extract</button> '
        + (e.entity_id ? '<button class="ads-btn" data-recrawl="' + esc(e.entity_id) + '">Recrawl entity</button>' : '')
        + '</td></tr>';
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
      var scopes = [];
      (r.paused_hosts || []).forEach(function (h) { scopes.push("host:" + h); });
      (r.paused_profile_types || []).forEach(function (t) { scopes.push("type:" + t); });
      $("#ops-paused-scopes").textContent = scopes.length ? "(" + scopes.join(", ") + ")" : "";
    } catch (e) { /* ignore */ }
  }

  async function refreshAll() {
    var stamp = new Date().toLocaleTimeString();
    $("#ops-last-refresh").textContent = "last refresh " + stamp;
    var jobs = [loadDriftBanner(), loadPauseState(), loadThroughput(), loadHosts(),
                loadFrontier(), loadAiSpend(), loadAdapters(), loadCompliance(),
                loadSeeds(), loadExtractions(), loadAudit()];
    await Promise.allSettled(jobs);
  }

  // ---- event wiring ------------------------------------------------------
  document.addEventListener("click", async function (e) {
    var t = e.target;
    if (!t || t.tagName !== "BUTTON") return;
    try {
      if (t.dataset.action === "refresh")        { await refreshAll(); return; }
      if (t.dataset.action === "pause-global")   {
        var reason = prompt("Reason for pausing the crawler? (optional)") || "";
        await post("/pause", { scope: "all", reason: reason }); await refreshAll(); return;
      }
      if (t.dataset.action === "resume-global")  { await post("/resume", { scope: "all" }); await refreshAll(); return; }
      if (t.dataset.action === "pause-type")     {
        var ptid = t.dataset.type;
        if (!confirm("Pause profile type '" + ptid + "'?")) return;
        await post("/pause", { scope: "profile_type", target: ptid });
        await refreshAll(); return;
      }
      if (t.dataset.replay) {
        t.disabled = true; t.textContent = "running…";
        var rep = await post("/extractions/" + encodeURIComponent(t.dataset.replay) + "/replay", {});
        alert("Replay complete:\n" + JSON.stringify(rep, null, 2));
        t.disabled = false; t.textContent = "Replay extract";
        loadAudit(); return;
      }
      if (t.dataset.recrawl) {
        await post("/recrawl-entity", { entity_id: t.dataset.recrawl, reason: "operator console" });
        t.textContent = "queued"; t.disabled = true; loadAudit(); return;
      }
      if (t.dataset.hostAction) {
        var host = t.dataset.host;
        var act = t.dataset.hostAction;
        if (act === "test") {
          t.disabled = true; t.textContent = "fetching…";
          var rt = await post("/hosts/" + encodeURIComponent(host) + "/test", {});
          alert("Test fetch for " + host + ":\n" + JSON.stringify(rt, null, 2));
          t.disabled = false; t.textContent = "Test fetch";
        } else if (act === "quarantine") {
          var until = prompt("Quarantine until (ISO timestamp, blank = indefinite):", "") || null;
          var reason2 = prompt("Reason?", "") || null;
          await post("/hosts/" + encodeURIComponent(host) + "/quarantine", { until: until, reason: reason2 });
        } else if (act === "unquarantine") {
          await post("/hosts/" + encodeURIComponent(host) + "/unquarantine", {});
        } else if (act === "whitelist") {
          if (!confirm("Whitelist " + host + "? (clears quarantine)")) return;
          await post("/hosts/" + encodeURIComponent(host) + "/whitelist", {});
        } else if (act === "set-rps") {
          var rpsStr = prompt("Max requests per second for " + host + ":", "0.5");
          if (rpsStr == null) return;
          await post("/hosts/" + encodeURIComponent(host) + "/rps", { max_rps: Number(rpsStr) });
        } else if (act === "clear-robots") {
          await post("/hosts/" + encodeURIComponent(host) + "/clear-robots", {});
        } else if (act === "pause-host") {
          if (!confirm("Pause all fetches for " + host + "?")) return;
          await post("/pause", { scope: "host", target: host });
        }
        await loadHosts(); await loadAudit(); await loadPauseState();
      }
    } catch (err) { if (err.message !== "forbidden") alert("Action failed: " + err.message); }
  });

  var hostFilterForm = document.getElementById("ops-host-filter");
  if (hostFilterForm) {
    hostFilterForm.addEventListener("submit", function (e) {
      e.preventDefault();
      hostFilter.q = hostFilterForm.elements.q.value.trim();
      hostFilter.status = hostFilterForm.elements.status.value;
      loadHosts();
    });
  }

  var spendSel = document.getElementById("ops-aispend-window");
  if (spendSel) spendSel.addEventListener("change", function () { aiSpendWindow = spendSel.value; loadAiSpend(); });

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

  var seedForm = document.getElementById("ops-add-seed");
  if (seedForm) {
    seedForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var body = {
        profile_type_id: seedForm.elements.profile_type_id.value.trim(),
        seed_kind: seedForm.elements.seed_kind.value,
        value: seedForm.elements.value.value.trim(),
      };
      try {
        await post("/seeds", body);
        seedForm.reset();
        await loadSeeds(); await loadAudit();
      } catch (err) { alert("Add seed failed: " + err.message); }
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

  // Pre-flight admin check: ping /api/ops/crawler/ root, which is
  // already gated by accessGuard+adminOnly. A 403 swaps the page to
  // a forbidden state and halts polling. This is the page-level
  // admin gate spec'd in Task #2 step 9 (Jekyll renders the HTML
  // statically; gating is enforced at load time by the API.)
  (async function init() {
    try {
      await api("/");
      start();
    } catch (e) { /* showForbidden already invoked on 403 */ }
  })();
})();
