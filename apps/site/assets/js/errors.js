// Task #27: errors dashboard.
(function () {
  const API = "https://api.aidatasignal.com";

  const $ = (id) => document.getElementById(id);
  function fmtTime(s) { try { return new Date(s).toLocaleString(); } catch { return s; } }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function kindBadge(kind) {
    const colors = { transient: "#a48117", permanent: "#b3261e", config: "#5b3fa5", auth: "#1c5fa5", validation: "#1f6e3f", upstream: "#7a3a06", internal: "#6b2826" };
    const bg = colors[kind] || "#444";
    return `<span style="display:inline-block;background:${bg};color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;font-weight:600">${esc(kind)}</span>`;
  }
  const KIND_COLORS = { transient: "#d4a017", permanent: "#b3261e", config: "#5b3fa5", auth: "#1c5fa5", validation: "#1f6e3f", upstream: "#c97e2a", internal: "#6b2826" };

  async function jget(path) {
    const r = await fetch(API + path, { credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function jpost(path, body) {
    const r = await fetch(API + path, {
      method: "POST",
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json().catch(() => ({}));
  }

  function buildQuery() {
    const q = $("ads-err-q").value.trim();
    const kind = $("ads-err-kind").value;
    const code = $("ads-err-code").value.trim();
    const job = $("ads-err-job").value.trim();
    const host = $("ads-err-host").value.trim();
    const resolved = $("ads-err-resolved").value;
    const since = $("ads-err-since").value ? new Date($("ads-err-since").value).toISOString() : "";
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (kind) params.set("kind", kind);
    if (code) params.set("code", code);
    if (job) params.set("job_id", job);
    if (host) params.set("host", host);
    if (resolved) params.set("resolved", resolved);
    if (since) params.set("since", since);
    params.set("limit", "200");
    return params.toString();
  }

  // ---- 7-day chart (vanilla canvas, no chart lib dependency) -------------
  async function loadChart() {
    const cv = $("ads-err-chart");
    const legend = $("ads-err-chart-legend");
    try {
      const j = await jget("/api/errors/timeseries?days=7");
      const points = j.points || [];
      // Bucket by hour, stacked by kind.
      const hours = new Set();
      const kindSet = new Set();
      const grid = {};
      for (const p of points) {
        hours.add(p.bucket);
        kindSet.add(p.kind);
        grid[p.bucket] = grid[p.bucket] || {};
        grid[p.bucket][p.kind] = (grid[p.bucket][p.kind] || 0) + p.n;
      }
      const allHours = [...hours].sort();
      const allKinds = [...kindSet];
      // If empty, draw an empty axis.
      const ctx = cv.getContext("2d");
      const W = cv.width, H = cv.height, padL = 28, padR = 8, padT = 8, padB = 18;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#fafafa"; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);
      if (!allHours.length) { legend.textContent = "No errors in the last 7 days."; return; }
      const totals = allHours.map((h) => allKinds.reduce((s, k) => s + (grid[h][k] || 0), 0));
      const max = Math.max(1, ...totals);
      const bw = (W - padL - padR) / allHours.length;
      allHours.forEach((h, i) => {
        let y = H - padB;
        for (const k of allKinds) {
          const v = grid[h][k] || 0;
          if (!v) continue;
          const bh = (v / max) * (H - padT - padB);
          ctx.fillStyle = KIND_COLORS[k] || "#888";
          ctx.fillRect(padL + i * bw + 0.5, y - bh, Math.max(1, bw - 1), bh);
          y -= bh;
        }
      });
      // Y-axis label.
      ctx.fillStyle = "#666"; ctx.font = "10px sans-serif";
      ctx.fillText(String(max), 2, padT + 8);
      ctx.fillText("0", 2, H - padB - 2);
      // X-axis ticks (every ~24 hours).
      const tickEvery = Math.max(1, Math.floor(allHours.length / 7));
      allHours.forEach((h, i) => {
        if (i % tickEvery !== 0) return;
        const label = h.slice(5, 10); // MM-DD
        ctx.fillText(label, padL + i * bw, H - 4);
      });
      legend.innerHTML = "Stacked by kind: " + allKinds.map((k) => `<span style="display:inline-block;width:10px;height:10px;background:${KIND_COLORS[k]||"#888"};margin:0 4px 0 10px;vertical-align:middle"></span>${esc(k)}`).join("");
    } catch (e) {
      legend.textContent = "Failed to load chart: " + e.message;
    }
  }

  async function loadSummary() {
    const el = $("ads-err-summary");
    try {
      const j = await jget("/api/errors/summary");
      if (!j.by_code || !j.by_code.length) { el.innerHTML = '<div class="ads-empty">No errors in the last 24h. </div>'; return; }
      const rows = j.by_code.map((r) => `
        <tr>
          <td>${kindBadge(r.kind)}</td>
          <td><a href="#" data-code="${esc(r.code)}" class="ads-err-code-link"><code>${esc(r.code)}</code></a></td>
          <td style="text-align:right"><strong>${r.n}</strong></td>
          <td style="text-align:right">${r.open_n || 0}</td>
          <td style="text-align:right">${r.retryable_n || 0}</td>
          <td class="ads-muted">${fmtTime(r.last_at)}</td>
        </tr>`).join("");
      el.innerHTML = `
        <div class="ads-muted" style="font-size:12px;margin-bottom:6px">Total in window: <strong>${j.total}</strong></div>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid #eee"><th style="text-align:left">Kind</th><th style="text-align:left">Code</th><th style="text-align:right">Count</th><th style="text-align:right">Open</th><th style="text-align:right">Retryable</th><th style="text-align:left">Last</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      el.querySelectorAll(".ads-err-code-link").forEach((a) => {
        a.addEventListener("click", (ev) => { ev.preventDefault(); $("ads-err-code").value = a.dataset.code; loadList(); });
      });
    } catch (e) {
      el.innerHTML = '<div class="ads-empty">Failed to load summary: ' + esc(e.message) + '</div>';
    }
  }

  async function loadClusters() {
    const el = $("ads-err-clusters");
    try {
      const j = await jget("/api/errors/clusters");
      const clusters = (j.clusters || []).filter((c) => c.open_n > 0);
      if (!clusters.length) { el.innerHTML = '<div class="ads-empty">No open clusters in the last 7 days.</div>'; return; }
      const rows = clusters.slice(0, 25).map((r) => `
        <tr style="border-bottom:1px solid #f0f0f0">
          <td><code style="font-size:12px"><a href="#" data-code="${esc(r.code)}" data-host="${esc(r.host)}" class="ads-err-cluster-link">${esc(r.code)}</a></code></td>
          <td style="font-size:12px" class="ads-muted">${esc(r.host || "—")}</td>
          <td style="text-align:right"><strong>${r.open_n}</strong></td>
          <td style="text-align:right" class="ads-muted">${r.n}</td>
          <td style="text-align:right" class="ads-muted">${r.distinct_jobs}</td>
          <td class="ads-muted" style="font-size:11px">${fmtTime(r.last_at)}</td>
        </tr>`).join("");
      el.innerHTML = `
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid #eee;text-align:left"><th>Code</th><th>Host</th><th style="text-align:right">Open</th><th style="text-align:right">Total</th><th style="text-align:right">Jobs</th><th>Last</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      el.querySelectorAll(".ads-err-cluster-link").forEach((a) => {
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          $("ads-err-code").value = a.dataset.code;
          $("ads-err-host").value = a.dataset.host || "";
          $("ads-err-resolved").value = "false";
          loadList();
        });
      });
    } catch (e) {
      el.innerHTML = '<div class="ads-empty">Failed to load clusters: ' + esc(e.message) + '</div>';
    }
  }

  async function loadList() {
    const el = $("ads-err-list");
    el.innerHTML = '<div class="ads-loading">Loading…</div>';
    try {
      const j = await jget("/api/errors?" + buildQuery());
      if (!j.items || !j.items.length) { el.innerHTML = '<div class="ads-empty">No errors match.</div>'; return; }
      const rows = j.items.map((r) => `
        <tr style="border-bottom:1px solid #f0f0f0;cursor:pointer;${r.resolved ? "opacity:.55;" : ""}" data-id="${r.id}" class="ads-err-row">
          <td class="ads-muted" style="font-size:12px;white-space:nowrap">${fmtTime(r.occurred_at)}</td>
          <td>${kindBadge(r.kind)}</td>
          <td><code style="font-size:12px">${esc(r.code)}</code></td>
          <td style="font-size:12px">${esc(r.message || "")}</td>
          <td style="font-size:11px" class="ads-muted">${esc(r.host || "")}</td>
          <td style="font-size:11px" class="ads-muted">${r.job_id ? esc(r.job_id.slice(0, 8)) : ""}</td>
          <td style="font-size:11px" class="ads-muted">${esc(r.step || "")}</td>
          <td style="font-size:11px" class="ads-muted">${r.resolved ? "✓" : ""}</td>
        </tr>`).join("");
      el.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:1px solid #ddd;text-align:left"><th>When</th><th>Kind</th><th>Code</th><th>Message</th><th>Host</th><th>Job</th><th>Step</th><th>R</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      el.querySelectorAll(".ads-err-row").forEach((tr) => {
        tr.addEventListener("click", () => openModal(tr.dataset.id));
      });
    } catch (e) {
      el.innerHTML = '<div class="ads-empty">Failed to load: ' + esc(e.message) + '</div>';
    }
  }

  async function openModal(id) {
    const modal = $("ads-err-modal");
    const body = $("ads-err-modal-body");
    const replay = $("ads-err-modal-replay");
    const resolveBtn = $("ads-err-modal-resolve");
    const resolveClusterBtn = $("ads-err-modal-resolve-cluster");
    const jobLink = $("ads-err-modal-job-link");
    const msg = $("ads-err-modal-msg");
    msg.textContent = "";
    body.innerHTML = '<div class="ads-loading">Loading…</div>';
    modal.hidden = false;
    try {
      const r = await jget("/api/errors/" + id);
      $("ads-err-modal-title").innerHTML = kindBadge(r.kind) + ` <code>${esc(r.code)}</code>` + (r.resolved ? ' <span style="color:#1f6e3f;font-size:12px">resolved</span>' : "");
      const ctxStr = r.context ? JSON.stringify(r.context, null, 2) : "(none)";
      body.innerHTML = `
        <dl style="display:grid;grid-template-columns:140px 1fr;gap:6px 12px;font-size:13px">
          <dt class="ads-muted">When</dt><dd>${fmtTime(r.occurred_at)}</dd>
          <dt class="ads-muted">Status</dt><dd>${r.status} · retryable=${r.retryable} · retry_count=${r.retry_count ?? 0}</dd>
          <dt class="ads-muted">Request</dt><dd><code>${esc(r.request_id || "")}</code></dd>
          <dt class="ads-muted">Workflow</dt><dd><code>${esc(r.workflow_run_id || "")}</code></dd>
          <dt class="ads-muted">Job</dt><dd><code>${esc(r.job_id || "")}</code> ${r.step ? `· step=<code>${esc(r.step)}</code>` : ""}</dd>
          <dt class="ads-muted">Host</dt><dd><code>${esc(r.host || "")}</code></dd>
          <dt class="ads-muted">URL</dt><dd>${r.method ? esc(r.method) + " " : ""}<code>${esc(r.url || "")}</code></dd>
          <dt class="ads-muted">User</dt><dd>${esc(r.user_email || "")}</dd>
          <dt class="ads-muted">Message</dt><dd>${esc(r.message || "")}</dd>
          ${r.resolved ? `<dt class="ads-muted">Resolved</dt><dd>${fmtTime(r.resolved_at)} · ${esc(r.resolved_by || "")}</dd>` : ""}
        </dl>
        <details open style="margin-top:10px"><summary>Context</summary><pre style="background:#f6f6f6;color:#111;padding:10px;border-radius:4px;overflow:auto;font-size:12px">${esc(ctxStr)}</pre></details>
        ${r.cause_stack ? `<details style="margin-top:10px"><summary>Cause stack</summary><pre style="background:#f6f6f6;color:#111;padding:10px;border-radius:4px;overflow:auto;font-size:11px">${esc(r.cause_stack)}</pre></details>` : ""}
        ${(r.cluster_recent && r.cluster_recent.length) ? `
          <div style="margin-top:14px">
            <div style="font-weight:600;font-size:13px;margin-bottom:6px">Last ${r.cluster_recent.length} same <code>{${esc(r.code)}, ${esc(r.host || "—")}}</code></div>
            <table style="width:100%;font-size:12px;border-collapse:collapse">
              <thead><tr style="text-align:left;border-bottom:1px solid #eee"><th>When</th><th>Job</th><th>Retries</th><th>Message</th><th>State</th></tr></thead>
              <tbody>${r.cluster_recent.map((x) => `
                <tr style="border-bottom:1px solid #f4f4f4">
                  <td>${fmtTime(x.occurred_at)}</td>
                  <td><code>${esc((x.job_id || "").slice(0,8))}</code></td>
                  <td>${x.retry_count ?? 0}</td>
                  <td>${esc((x.message || "").slice(0,120))}</td>
                  <td>${x.resolved ? '<span style="color:#1f6e3f">resolved</span>' : '<span style="color:#b3261e">open</span>'}</td>
                </tr>`).join("")}</tbody>
            </table>
          </div>` : ""}
      `;
      resolveBtn.hidden = !!r.resolved;
      resolveBtn.dataset.errId = r.id;
      resolveClusterBtn.hidden = !!r.resolved;
      resolveClusterBtn.dataset.errId = r.id;
      if (r.job_id) {
        replay.hidden = false;
        replay.dataset.errId = r.id;
        jobLink.hidden = false;
        jobLink.href = "/dashboard/jobs/?id=" + encodeURIComponent(r.job_id);
      } else {
        replay.hidden = true;
        jobLink.hidden = true;
      }
    } catch (e) {
      body.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>';
    }
  }

  function closeModal() { $("ads-err-modal").hidden = true; }

  document.addEventListener("DOMContentLoaded", () => {
    $("ads-err-refresh").addEventListener("click", () => { loadChart(); loadSummary(); loadClusters(); loadList(); });
    $("ads-err-modal-close").addEventListener("click", closeModal);
    $("ads-err-modal").addEventListener("click", (ev) => { if (ev.target.id === "ads-err-modal") closeModal(); });
    $("ads-err-modal-replay").addEventListener("click", async (ev) => {
      const id = ev.currentTarget.dataset.errId;
      const msg = $("ads-err-modal-msg");
      msg.textContent = "Replaying…";
      try {
        const r = await jpost("/api/errors/" + id + "/replay");
        if (r.ok) { msg.innerHTML = `Replayed → <a href="/dashboard/jobs/?id=${encodeURIComponent(r.replay_job_id)}">${esc(r.replay_job_id)}</a>`; }
        else { msg.textContent = "Replay failed: " + (r.error || "unknown"); }
      } catch (e) { msg.textContent = "Replay failed: " + e.message; }
    });
    $("ads-err-modal-resolve").addEventListener("click", async (ev) => {
      const id = ev.currentTarget.dataset.errId;
      const msg = $("ads-err-modal-msg");
      msg.textContent = "Resolving…";
      try {
        const r = await jpost("/api/errors/" + id + "/resolve");
        if (r.ok) { msg.textContent = `Marked resolved.`; loadList(); loadClusters(); loadSummary(); }
        else { msg.textContent = "Resolve failed: " + (r.error || "unknown"); }
      } catch (e) { msg.textContent = "Resolve failed: " + e.message; }
    });
    $("ads-err-modal-resolve-cluster").addEventListener("click", async (ev) => {
      const id = ev.currentTarget.dataset.errId;
      const msg = $("ads-err-modal-msg");
      if (!(await window.ADS.ui.confirm({ title: "Resolve entire cluster?", body: "Every open error in this (code, host) cluster will be marked resolved." }))) return;
      msg.textContent = "Resolving cluster…";
      try {
        const r = await jpost("/api/errors/" + id + "/resolve", { cluster: true });
        if (r.ok) { msg.textContent = `Marked ${r.resolved} errors resolved.`; loadList(); loadClusters(); loadSummary(); }
        else { msg.textContent = "Resolve failed: " + (r.error || "unknown"); }
      } catch (e) { msg.textContent = "Resolve failed: " + e.message; }
    });
    loadChart();
    loadSummary();
    loadClusters();
    loadList();
  });
})();
