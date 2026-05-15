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

  async function jget(path) {
    const r = await fetch(API + path, { credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function jpost(path) {
    const r = await fetch(API + path, { method: "POST", credentials: "include" });
    return r.json().catch(() => ({}));
  }

  function buildQuery() {
    const q = $("ads-err-q").value.trim();
    const kind = $("ads-err-kind").value;
    const code = $("ads-err-code").value.trim();
    const job = $("ads-err-job").value.trim();
    const since = $("ads-err-since").value ? new Date($("ads-err-since").value).toISOString() : "";
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (kind) params.set("kind", kind);
    if (code) params.set("code", code);
    if (job) params.set("job_id", job);
    if (since) params.set("since", since);
    params.set("limit", "200");
    return params.toString();
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
          <td style="text-align:right">${r.retryable_n || 0}</td>
          <td class="ads-muted">${fmtTime(r.last_at)}</td>
        </tr>`).join("");
      el.innerHTML = `
        <div class="ads-muted" style="font-size:12px;margin-bottom:6px">Total in window: <strong>${j.total}</strong></div>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid #eee"><th style="text-align:left">Kind</th><th style="text-align:left">Code</th><th style="text-align:right">Count</th><th style="text-align:right">Retryable</th><th style="text-align:left">Last</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      el.querySelectorAll(".ads-err-code-link").forEach((a) => {
        a.addEventListener("click", (ev) => { ev.preventDefault(); $("ads-err-code").value = a.dataset.code; loadList(); });
      });
    } catch (e) {
      el.innerHTML = '<div class="ads-empty">Failed to load summary: ' + esc(e.message) + '</div>';
    }
  }

  async function loadList() {
    const el = $("ads-err-list");
    el.innerHTML = '<div class="ads-loading">Loading…</div>';
    try {
      const j = await jget("/api/errors?" + buildQuery());
      if (!j.items || !j.items.length) { el.innerHTML = '<div class="ads-empty">No errors match.</div>'; return; }
      const rows = j.items.map((r) => `
        <tr style="border-bottom:1px solid #f0f0f0;cursor:pointer" data-id="${r.id}" class="ads-err-row">
          <td class="ads-muted" style="font-size:12px;white-space:nowrap">${fmtTime(r.occurred_at)}</td>
          <td>${kindBadge(r.kind)}</td>
          <td><code style="font-size:12px">${esc(r.code)}</code></td>
          <td style="font-size:12px">${esc(r.message || "")}</td>
          <td style="font-size:11px" class="ads-muted">${r.job_id ? esc(r.job_id.slice(0, 8)) : ""}</td>
          <td style="font-size:11px" class="ads-muted">${esc(r.step || "")}</td>
        </tr>`).join("");
      el.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:1px solid #ddd;text-align:left"><th>When</th><th>Kind</th><th>Code</th><th>Message</th><th>Job</th><th>Step</th></tr></thead>
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
    const jobLink = $("ads-err-modal-job-link");
    const msg = $("ads-err-modal-msg");
    msg.textContent = "";
    body.innerHTML = '<div class="ads-loading">Loading…</div>';
    modal.hidden = false;
    try {
      const r = await jget("/api/errors/" + id);
      $("ads-err-modal-title").innerHTML = kindBadge(r.kind) + ` <code>${esc(r.code)}</code>`;
      const ctxStr = r.context ? JSON.stringify(r.context, null, 2) : "(none)";
      body.innerHTML = `
        <dl style="display:grid;grid-template-columns:140px 1fr;gap:6px 12px;font-size:13px">
          <dt class="ads-muted">When</dt><dd>${fmtTime(r.occurred_at)}</dd>
          <dt class="ads-muted">Status</dt><dd>${r.status} · retryable=${r.retryable}</dd>
          <dt class="ads-muted">Request</dt><dd><code>${esc(r.request_id || "")}</code></dd>
          <dt class="ads-muted">Job</dt><dd><code>${esc(r.job_id || "")}</code> ${r.step ? `· step=<code>${esc(r.step)}</code>` : ""}</dd>
          <dt class="ads-muted">URL</dt><dd>${r.method ? esc(r.method) + " " : ""}<code>${esc(r.url || "")}</code></dd>
          <dt class="ads-muted">Message</dt><dd>${esc(r.message || "")}</dd>
        </dl>
        <details open style="margin-top:10px"><summary>Context</summary><pre style="background:#f6f6f6;padding:10px;border-radius:4px;overflow:auto;font-size:12px">${esc(ctxStr)}</pre></details>
        ${r.cause_stack ? `<details style="margin-top:10px"><summary>Cause stack</summary><pre style="background:#f6f6f6;padding:10px;border-radius:4px;overflow:auto;font-size:11px">${esc(r.cause_stack)}</pre></details>` : ""}
      `;
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
    $("ads-err-refresh").addEventListener("click", () => { loadSummary(); loadList(); });
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
    loadSummary();
    loadList();
  });
})();
