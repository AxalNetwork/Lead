// Task #9: /ops/compute-nodes/ front-end. Pre-flights
// /api/ops/compute-nodes/ (admin-only on the worker) before revealing
// page content — same gating pattern as /ops/crawler/ from Task #2.
// Per the Task #4 static-routing constraint every deep link uses
// `?id=<node_id>` query strings.
(function () {
  var API = "https://api.aidatasignal.com/api/ops/compute-nodes";
  var REFRESH_MS = 15000;
  var timer = null;

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function ago(s) {
    if (!s) return "—";
    var ms = Date.now() - new Date(s + (s.endsWith("Z") ? "" : "Z")).getTime();
    if (!isFinite(ms)) return "—";
    if (ms < 60000) return Math.round(ms / 1000) + "s ago";
    if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
    if (ms < 86400000) return Math.round(ms / 3600000) + "h ago";
    return Math.round(ms / 86400000) + "d ago";
  }
  function dollars(v) { return "$" + (Number(v) || 0).toFixed(4); }

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
    var chk = document.getElementById("ops-auth-check");
    if (chk) chk.hidden = true;
    var content = document.getElementById("ops-content");
    if (content) { content.hidden = true; content.innerHTML = ""; }
    var f = document.getElementById("ops-forbidden");
    if (f) f.hidden = false;
    stop();
  }
  function revealContent() {
    var chk = document.getElementById("ops-auth-check");
    if (chk) chk.hidden = true;
    var content = document.getElementById("ops-content");
    if (content) content.hidden = false;
  }

  async function loadNodes() {
    var r = await api("/nodes");
    var tbody = document.querySelector("#ops-nodes tbody");
    if (!r.items || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="ads-empty">No nodes registered.</td></tr>';
      return;
    }
    tbody.innerHTML = r.items.map(function (n) {
      var fresh = n.last_heartbeat_at && (Date.now() - new Date(n.last_heartbeat_at + "Z").getTime()) < 90000;
      var dot = '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' +
        (n.enabled && fresh ? '#23d6a4' : n.drain ? '#f0b400' : '#e36a6a') + '"></span>';
      var state = !n.enabled ? '<span class="ads-pill ads-pill--err">disabled</span>'
        : n.drain ? '<span class="ads-pill ads-pill--warn">draining</span>'
        : fresh ? '<span class="ads-pill ads-pill--ok">healthy</span>'
        : '<span class="ads-pill ads-pill--warn">stale</span>';
      return '<tr>'
        + '<td>' + dot + '</td>'
        + '<td><a href="?id=' + encodeURIComponent(n.id) + '"><code class="ads-mono">' + esc(n.name) + '</code></a>'
        + ' <span class="ads-sub">' + esc(n.id) + '</span></td>'
        + '<td>' + esc(n.provider) + ' / ' + esc(n.kind) + '</td>'
        + '<td>' + Number(n.current_active_jobs || 0) + ' / ' + Number(n.max_concurrent_jobs || 0) + '</td>'
        + '<td>' + dollars(n.cost_per_hour_usd) + '</td>'
        + '<td>' + ago(n.last_heartbeat_at) + '</td>'
        + '<td>' + state + '</td>'
        + '<td>' + esc(n.last_error || '') + '</td>'
        + '<td>'
        + '<button class="ads-btn" data-act="pause" data-id="' + esc(n.id) + '">Pause</button> '
        + '<button class="ads-btn" data-act="drain" data-id="' + esc(n.id) + '">Drain</button> '
        + '<button class="ads-btn" data-act="resume" data-id="' + esc(n.id) + '">Resume</button> '
        + '<button class="ads-btn" data-act="delete" data-id="' + esc(n.id) + '">Delete</button>'
        + '</td></tr>';
    }).join("");
  }

  async function loadSpend() {
    var r = await api("/spend?window=day");
    $("#ops-spend-total").textContent = "24h total: " + dollars(r.total_cost_usd);
    var tbody = document.querySelector("#ops-spend tbody");
    var rows = r.by_node || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="ads-empty">No jobs in the last 24h.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (row) {
      return '<tr>'
        + '<td><code class="ads-mono">' + esc(row.node_name || row.node_id) + '</code></td>'
        + '<td>' + esc(row.provider || '—') + '</td>'
        + '<td>' + esc(row.kind || '—') + '</td>'
        + '<td>' + Number(row.jobs || 0) + '</td>'
        + '<td>' + Number(row.completed || 0) + '</td>'
        + '<td>' + Number(row.failed || 0) + '</td>'
        + '<td>' + Number(row.timeouts || 0) + '</td>'
        + '<td>' + Number(row.runtime_ms || 0).toLocaleString() + '</td>'
        + '<td>' + dollars(row.cost_usd) + '</td>'
        + '</tr>';
    }).join("");
  }

  async function loadAssignments() {
    var r = await api("/assignments?limit=50");
    var tbody = document.querySelector("#ops-assignments tbody");
    var items = r.items || [];
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="ads-empty">No assignments yet.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (a) {
      var pill = a.status === "completed" ? "ok" : a.status === "failed" || a.status === "timeout" ? "err" : "warn";
      return '<tr>'
        + '<td>' + ago(a.dispatched_at) + '</td>'
        + '<td><code class="ads-mono">' + esc(a.node_id) + '</code></td>'
        + '<td>' + esc(a.job_type) + '</td>'
        + '<td><code class="ads-mono">' + esc(a.job_id) + '</code></td>'
        + '<td><span class="ads-pill ads-pill--' + pill + '">' + esc(a.status) + '</span></td>'
        + '<td>' + Number(a.runtime_ms || 0).toLocaleString() + '</td>'
        + '<td>' + dollars(a.cost_usd) + '</td>'
        + '<td class="ads-sub">' + esc(a.error || '') + '</td>'
        + '</tr>';
    }).join("");
  }

  async function loadRouting() {
    var r = await api("/");
    var matrix = r.routing_matrix || {};
    var tbody = document.querySelector("#ops-routing tbody");
    var rows = Object.keys(matrix).map(function (jt) {
      var rule = matrix[jt];
      return '<tr><td><code class="ads-mono">' + esc(jt) + '</code></td>'
        + '<td>' + esc((rule.preferred_kinds || []).join(", ")) + '</td>'
        + '<td>' + (rule.prefer_external ? "yes" : "no") + '</td>'
        + '<td>' + (rule.external_ok ? "yes" : "no") + '</td>'
        + '<td>' + Number(rule.deadline_ms || 0) + '</td></tr>';
    }).join("");
    tbody.innerHTML = rows || '<tr><td colspan="5" class="ads-empty">—</td></tr>';
  }

  async function refreshAll() {
    try {
      await Promise.allSettled([loadNodes(), loadSpend(), loadAssignments(), loadRouting()]);
    } catch (e) { /* gating already handled */ }
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function start() { stop(); timer = setInterval(refreshAll, REFRESH_MS); }

  // Register-token wizard.
  document.addEventListener("submit", async function (e) {
    if (e.target.id !== "ops-add-node") return;
    e.preventDefault();
    var fd = new FormData(e.target);
    var sjt = String(fd.get("supported_job_types") || "")
      .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var body = {
      name: fd.get("name"),
      provider: fd.get("provider"),
      kind: fd.get("kind"),
      max_concurrent_jobs: Number(fd.get("max_concurrent_jobs")) || 1,
      cost_per_hour_usd: Number(fd.get("cost_per_hour_usd")) || 0,
      cost_per_1k_tokens_usd: Number(fd.get("cost_per_1k_tokens_usd")) || 0,
      supported_job_types: sjt,
      capabilities_json: {},
    };
    try {
      var r = await post("/register-token", body);
      var box = $("#ops-register-result");
      box.hidden = false;
      $("#ops-register-cmd").textContent = r.command;
      $("#ops-register-meta").textContent = "Token expires " + (r.expires_at || "");
    } catch (err) {
      alert("Failed to mint token: " + err.message);
    }
  });

  document.addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    var id = btn.getAttribute("data-id");
    if (act === "delete" && !confirm("Delete node " + id + "? This removes the HMAC secret from KV.")) return;
    try {
      if (act === "delete") {
        var r = await fetch(API + "/nodes/by-id?id=" + encodeURIComponent(id), {
          method: "DELETE", credentials: "include",
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
      } else {
        await post("/nodes/by-id/" + act + "?id=" + encodeURIComponent(id));
      }
      refreshAll();
    } catch (err) {
      alert("Action failed: " + err.message);
    }
  });

  // Pre-flight gate.
  api("/").then(function () { revealContent(); refreshAll(); start(); })
    .catch(function () { /* showForbidden already invoked on 403 */ });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else start();
  });
})();
