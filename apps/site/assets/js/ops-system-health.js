// Task #5: System Health & Errors dashboard front-end.
// Pre-flights /api/ops/system-health/ for admin gating; refreshes every 15s
// while the tab is visible.
(function () {
  var API = window.ADS_API_BASE + "/api/ops/system-health";
  var REFRESH_MS = 15000;
  var timer = null;

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function ago(s) {
    if (!s) return "—";
    var ms = Date.now() - new Date(s).getTime();
    if (ms < 0) return "—";
    if (ms < 60000) return Math.round(ms / 1000) + "s ago";
    if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
    if (ms < 86400000) return Math.round(ms / 3600000) + "h ago";
    return Math.round(ms / 86400000) + "d ago";
  }
  function fmtSec(s) {
    if (s == null) return "—";
    if (s < 60) return s + "s";
    if (s < 3600) return Math.round(s / 60) + "m";
    return Math.round(s / 3600) + "h";
  }
  function statusDot(s) {
    var color = s === "green" ? "#1aa260" : s === "yellow" ? "#d29900" : s === "drained" ? "#6b7280" : "#c0392b";
    return '<span style="display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:' + color + ';margin-right:.4rem" title="' + esc(s) + '"></span>';
  }
  function sparkline(points) {
    if (!points || !points.length) return '<span class="ads-mono" style="color:#6b7280">—</span>';
    var w = 120, h = 24;
    var vals = points.map(function (p) { return Number(p.depth || 0); });
    var max = Math.max.apply(null, vals.concat([1]));
    var step = vals.length > 1 ? w / (vals.length - 1) : 0;
    var d = vals.map(function (v, i) {
      var x = i * step;
      var y = h - (v / max) * (h - 2) - 1;
      return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="vertical-align:middle"><path d="' + d + '" fill="none" stroke="#5b8def" stroke-width="1.5"/></svg>';
  }

  async function api(path, opts) {
    var r = await window.adsUtil.request(API + path, Object.assign({ credentials: "include" }, opts || {}));
    if (r.status === 403) { showForbidden(); throw new Error("forbidden"); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function post(path, body) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  function showForbidden() {
    var chk = document.getElementById("ops-auth-check");
    if (chk) chk.hidden = true;
    var c = document.getElementById("ops-content");
    if (c) { c.hidden = true; c.innerHTML = ""; }
    var f = document.getElementById("ops-forbidden");
    if (f) f.hidden = false;
    stop();
  }
  function revealContent() {
    var chk = document.getElementById("ops-auth-check");
    if (chk) chk.hidden = true;
    var c = document.getElementById("ops-content");
    if (c) c.hidden = false;
  }
  function setStatus(msg) {
    var el = document.getElementById("ops-action-status");
    if (el) el.textContent = msg || "";
  }

  function renderIncidents(list) {
    var tb = document.querySelector("#ops-incidents-open tbody");
    if (!tb) return;
    if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="ads-sub">No open incidents.</td></tr>'; return; }
    tb.innerHTML = list.map(function (i) {
      return '<tr>' +
        '<td class="ads-mono">' + ago(i.opened_at) + '</td>' +
        '<td><span class="ads-mono" style="color:' + (i.severity === "critical" ? "#c0392b" : "#d29900") + '">' + esc(i.severity) + '</span></td>' +
        '<td class="ads-mono">' + esc(i.kind) + '</td>' +
        '<td>' + esc(i.summary) + '</td>' +
        '<td><a class="ads-btn" href="/ops/incidents/?id=' + encodeURIComponent(i.id) + '">Open</a></td>' +
        '</tr>';
    }).join("");
  }

  function renderCompute(list) {
    var tb = document.querySelector("#ops-compute tbody");
    if (!tb) return;
    if (!list.length) { tb.innerHTML = '<tr><td colspan="8" class="ads-sub">No compute nodes registered.</td></tr>'; return; }
    tb.innerHTML = list.map(function (n) {
      var drainLbl = n.drain ? "Undrain" : "Drain";
      return '<tr>' +
        '<td>' + statusDot(n.status) + esc(n.status) + '</td>' +
        '<td><strong>' + esc(n.name) + '</strong><br><span class="ads-mono" style="font-size:.75em;color:#6b7280">' + esc(n.id) + '</span></td>' +
        '<td class="ads-mono">' + esc(n.provider) + " / " + esc(n.kind) + '</td>' +
        '<td class="ads-mono">' + n.current_active_jobs + " / " + n.max_concurrent_jobs + '</td>' +
        '<td class="ads-mono">' + (n.p95_latency_ms == null ? "—" : n.p95_latency_ms + "ms") + '</td>' +
        '<td class="ads-mono">' + ago(n.last_heartbeat_at) + '</td>' +
        '<td class="ads-mono" style="max-width:18rem;overflow:hidden;text-overflow:ellipsis" title="' + esc(n.last_error || "") + '">' + esc(n.last_error || "—") + '</td>' +
        '<td><button class="ads-btn" data-drain="' + esc(n.id) + '" data-cur="' + (n.drain ? 1 : 0) + '">' + drainLbl + '</button></td>' +
        '</tr>';
    }).join("");
  }

  function renderQueues(list) {
    var tb = document.querySelector("#ops-queues tbody");
    if (!tb) return;
    if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="ads-sub">No queues.</td></tr>'; return; }
    tb.innerHTML = list.map(function (q) {
      return '<tr>' +
        '<td><strong>' + esc(q.queue_name) + '</strong></td>' +
        '<td class="ads-mono">' + q.depth + '</td>' +
        '<td class="ads-mono">' + fmtSec(q.oldest_age_seconds) + '</td>' +
        '<td class="ads-mono">' + q.failed_24h + '</td>' +
        '<td>' + sparkline(q.sparkline) + '</td>' +
        '</tr>';
    }).join("");
  }

  function renderD1(d1) {
    var el = document.getElementById("ops-d1");
    if (!el) return;
    el.innerHTML =
      'reads/sec ≈ <strong>' + d1.reads_per_sec_estimate.toFixed(2) + '</strong> · ' +
      'writes/sec ≈ <strong>' + d1.writes_per_sec_estimate.toFixed(2) + '</strong> · ' +
      'errors (24h) <strong>' + d1.errors_24h + '</strong> · ' +
      'throttled (24h) <strong style="color:' + (d1.throttled_24h > 10 ? "#c0392b" : "inherit") + '">' + d1.throttled_24h + '</strong>';
  }

  function renderBindings(r2, kv, vec) {
    var el = document.getElementById("ops-bindings");
    if (!el) return;
    function fmtBytes(n) {
      if (n == null) return "—";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
      return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }
    function src(s) {
      return '<span class="ads-sub" style="font-size:.8em">(' + esc(s || "unavailable") + ')</span>';
    }
    function r2Row(x) {
      if (!x.bound) return '<li><strong>' + esc(x.bucket) + '</strong>: <span style="color:#6b7280">not bound</span></li>';
      var n = x.objects_sampled == null ? "—" : (x.objects_sampled + (x.truncated ? "+" : ""));
      var err = x.error ? ' <span style="color:#c0392b">err: ' + esc(x.error) + '</span>' : '';
      return '<li><strong>' + esc(x.bucket) + '</strong>: objects ' + n + ' · bytes ' + fmtBytes(x.bytes_sampled) +
        ' · last_mod ' + esc(x.last_modified || "—") + ' ' + src(x.metric_source) + err + '</li>';
    }
    function kvRow(x) {
      if (!x.bound) return '<li><strong>' + esc(x.binding) + '</strong>: <span style="color:#6b7280">not bound</span></li>';
      var n = x.keys_sampled == null ? "—" : (x.keys_sampled + (x.truncated ? "+" : ""));
      var err = x.error ? ' <span style="color:#c0392b">err: ' + esc(x.error) + '</span>' : '';
      return '<li><strong>' + esc(x.binding) + '</strong>: keys ' + n + ' ' + src(x.metric_source) + err + '</li>';
    }
    function vRow(x) {
      if (!x.bound) return '<li><strong>' + esc(x.index) + '</strong>: <span style="color:#6b7280">not bound</span></li>';
      var vc = x.vector_count == null ? "—" : x.vector_count;
      var d = x.dimensions == null ? "—" : x.dimensions;
      var err = x.error ? ' <span style="color:#c0392b">err: ' + esc(x.error) + '</span>' : '';
      return '<li><strong>' + esc(x.index) + '</strong>: vectors ' + vc + ' · dim ' + d + ' ' + src(x.metric_source) + err + '</li>';
    }
    el.innerHTML =
      '<div><strong>R2</strong><ul style="margin:.25rem 0 .5rem 1rem">' + r2.map(r2Row).join("") + '</ul></div>' +
      '<div><strong>KV</strong><ul style="margin:.25rem 0 .5rem 1rem">' + kv.map(kvRow).join("") + '</ul></div>' +
      '<div><strong>Vectorize</strong><ul style="margin:.25rem 0 .5rem 1rem">' + vec.map(vRow).join("") + '</ul></div>';
  }

  function renderExternal(list) {
    var tb = document.querySelector("#ops-external tbody");
    if (!tb) return;
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="ads-sub">No external APIs registered.</td></tr>'; return; }
    tb.innerHTML = list.map(function (a) {
      var sr = a.success_rate_24h == null ? "—" : a.success_rate_24h.toFixed(1) + "%";
      return '<tr>' +
        '<td><strong>' + esc(a.api_name) + '</strong></td>' +
        '<td class="ads-mono">' + (a.configured ? "yes" : "<span style=\"color:#d29900\">unconfigured</span>") + '</td>' +
        '<td class="ads-mono">' + ago(a.last_success) + '</td>' +
        '<td class="ads-mono">' + sr + '</td>' +
        '<td class="ads-mono">' + (a.rate_limit_remaining == null ? "—" : a.rate_limit_remaining) + '</td>' +
        '<td class="ads-mono" style="max-width:18rem;overflow:hidden;text-overflow:ellipsis" title="' + esc(a.last_error || "") + '">' + esc(a.last_error || "—") + '</td>' +
        '<td><button class="ads-btn" data-probe="' + esc(a.api_name) + '">Probe now</button></td>' +
        '</tr>';
    }).join("");
  }

  function renderCrons(list) {
    var tb = document.querySelector("#ops-crons tbody");
    if (!tb) return;
    if (!list.length) { tb.innerHTML = '<tr><td colspan="3" class="ads-sub">No crons.</td></tr>'; return; }
    tb.innerHTML = list.map(function (c) {
      return '<tr>' +
        '<td>' + esc(c.name) + '</td>' +
        '<td class="ads-mono">' + esc(c.cron_expr) + '</td>' +
        '<td class="ads-mono">' + ago(c.last_run) + '</td>' +
        '</tr>';
    }).join("");
  }

  function renderErrors(errs, perMin) {
    var rateEl = document.getElementById("ops-erate");
    if (rateEl) {
      rateEl.textContent = perMin;
      rateEl.style.color = perMin > 5 ? "#c0392b" : "inherit";
    }
    var tb = document.querySelector("#ops-errors tbody");
    if (!tb) return;
    if (!errs.length) { tb.innerHTML = '<tr><td colspan="5" class="ads-sub">No errors in the last 24h.</td></tr>'; return; }
    tb.innerHTML = errs.map(function (e) {
      return '<tr>' +
        '<td class="ads-mono"><strong>' + e.count + '</strong></td>' +
        '<td class="ads-mono">' + ago(e.last_seen) + '</td>' +
        '<td class="ads-mono">' + esc(e.sample_code) + '</td>' +
        '<td class="ads-mono" style="max-width:14rem;overflow:hidden;text-overflow:ellipsis" title="' + esc(e.sample_route || "") + '">' + esc(e.sample_route || "—") + '</td>' +
        '<td class="ads-mono" style="max-width:32rem;overflow:hidden;text-overflow:ellipsis" title="' + esc(e.sample_message) + '">' + esc(e.sample_message) + '</td>' +
        '</tr>';
    }).join("");
  }

  async function tick() {
    try {
      var data = await api("/");
      revealContent();
      document.getElementById("ops-generated-at").textContent = "snapshot " + ago(data.generated_at);
      renderIncidents(data.open_incidents || []);
      // Compute strip: external nodes + Cloudflare Worker self-cards.
      var workers = (data.workers || []).map(function (w) {
        return {
          id: w.id, name: w.name, status: w.status,
          provider: "cloudflare", kind: w.kind || "cloudflare_worker",
          current_active_jobs: "—", max_concurrent_jobs: "—",
          p95_latency_ms: null,
          last_heartbeat_at: w.last_hourly_tick,
          last_error: null,
          enabled: 1, drain: 0,
        };
      });
      renderCompute(workers.concat(data.compute_pool || []));
      renderQueues(data.queues || []);
      renderD1(data.d1);
      renderBindings(data.r2 || [], data.kv || [], data.vectorize || []);
      renderExternal(data.external_apis || []);
      renderCrons(data.crons || []);
      renderErrors((data.errors && data.errors.recent) || [], (data.errors && data.errors.per_min) || 0);
    } catch (e) {
      if ((e && e.message) !== "forbidden") {
        setStatus("refresh failed: " + (e && e.message));
      }
    }
  }

  function start() { stop(); tick(); timer = setInterval(tick, REFRESH_MS); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  document.addEventListener("click", async function (ev) {
    var t = ev.target;
    if (!(t && t.tagName === "BUTTON")) return;
    var probe = t.getAttribute("data-probe");
    var drain = t.getAttribute("data-drain");
    var action = t.getAttribute("data-action");
    try {
      if (probe) {
        setStatus("probing " + probe + "…");
        var r = await post("/probe/" + encodeURIComponent(probe), {});
        setStatus(probe + ": " + (r.ok ? "ok " + r.latency_ms + "ms" : "FAIL " + (r.error || "")));
        await tick();
      } else if (drain) {
        var cur = Number(t.getAttribute("data-cur") || 0);
        setStatus((cur ? "undraining " : "draining ") + drain + "…");
        await post("/nodes/" + encodeURIComponent(drain) + "/drain", { drain: !cur });
        setStatus("drain toggled");
        await tick();
      } else if (action === "probe-all") {
        setStatus("probing all APIs…");
        var rr = await post("/probe-all", {});
        setStatus("probed " + rr.probed + " APIs");
        await tick();
      } else if (action === "snapshot") {
        setStatus("writing snapshot…");
        await post("/snapshot", {});
        setStatus("snapshot written");
        await tick();
      }
    } catch (e) {
      setStatus("error: " + (e && e.message));
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else start();
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
