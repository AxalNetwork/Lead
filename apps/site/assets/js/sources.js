// Task #5: Source registry dashboard.
(function () {
  const API = "https://api.aidatasignal.com";
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function fmtTime(s) { if (!s) return "—"; try { return new Date(s).toLocaleString(); } catch { return s; } }
  function ago(s) {
    if (!s) return "never";
    const d = (Date.now() - new Date(s).getTime()) / 1000;
    if (d < 60) return Math.round(d) + "s ago";
    if (d < 3600) return Math.round(d / 60) + "m ago";
    if (d < 86400) return Math.round(d / 3600) + "h ago";
    return Math.round(d / 86400) + "d ago";
  }
  function until(s) {
    if (!s) return "—";
    const d = (new Date(s).getTime() - Date.now()) / 1000;
    if (d < 0) return "due now";
    if (d < 3600) return "in " + Math.round(d / 60) + "m";
    if (d < 86400) return "in " + Math.round(d / 3600) + "h";
    return "in " + Math.round(d / 86400) + "d";
  }

  async function jget(path) {
    const r = await fetch(API + path, { credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
    return r.json();
  }
  async function jsend(method, path, body) {
    const r = await fetch(API + path, {
      method, credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = {}; try { data = JSON.parse(text); } catch { /* */ }
    if (!r.ok) { const err = new Error(data.error || data.message || ("HTTP " + r.status)); err.data = data; throw err; }
    return data;
  }

  let allItems = [];

  function statusBadge(row) {
    const s = row.last_run_status || (row.enabled ? "pending" : "disabled");
    const colors = {
      succeeded: "#1f6e3f", partial: "#a48117", failed: "#b3261e",
      running: "#1c5fa5", pending: "#666", disabled: "#888", archived: "#444",
    };
    const bg = colors[s] || "#444";
    return `<span style="display:inline-block;background:${bg};color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;font-weight:600">${esc(s)}</span>`;
  }

  function filterRow(row, q, importer, statusFilter, category, region) {
    if (importer && row.importer !== importer) return false;
    if (category && row.category !== category) return false;
    if (region && row.region !== region) return false;
    if (statusFilter === "enabled" && !row.enabled) return false;
    if (statusFilter === "disabled" && row.enabled) return false;
    if (statusFilter === "archived" && row.last_run_status !== "archived") return false;
    if (statusFilter === "failing" && (row.consecutive_failures || 0) < 2) return false;
    if (statusFilter === "due") {
      const due = !row.next_run_after || new Date(row.next_run_after).getTime() <= Date.now();
      if (!row.enabled || !due) return false;
    }
    if (q) {
      const hay = (row.url + " " + (row.label || "") + " " + (row.url_host || "")).toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }

  function refreshFacets() {
    const cats = [...new Set(allItems.map((r) => r.category).filter(Boolean))].sort();
    const regs = [...new Set(allItems.map((r) => r.region).filter(Boolean))].sort();
    function fill(id, vals) {
      const el = $(id); if (!el) return;
      const cur = el.value;
      el.innerHTML = `<option value="">all</option>` + vals.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
      if (vals.includes(cur)) el.value = cur;
    }
    fill("ads-src-category", cats);
    fill("ads-src-region", regs);
  }

  function renderList() {
    const q = $("ads-src-q").value.trim();
    const importer = $("ads-src-importer").value;
    const statusFilter = $("ads-src-status").value;
    const category = $("ads-src-category") ? $("ads-src-category").value : "";
    const region = $("ads-src-region") ? $("ads-src-region").value : "";
    const rows = allItems.filter((r) => filterRow(r, q, importer, statusFilter, category, region));
    if (rows.length === 0) {
      $("ads-src-list").innerHTML = `<div class="ads-muted" style="padding:16px">No sources match.</div>`;
      return;
    }
    const html = [`<table class="ads-table" style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="text-align:left;border-bottom:1px solid #ddd">
        <th style="padding:6px">URL</th>
        <th style="padding:6px">Importer</th>
        <th style="padding:6px">Status</th>
        <th style="padding:6px">Last run</th>
        <th style="padding:6px">Next</th>
        <th style="padding:6px">Last seen</th>
        <th style="padding:6px">Runs</th>
        <th style="padding:6px"></th>
      </tr></thead><tbody>`];
    for (const r of rows) {
      const lastStats = [r.records_seen_last, r.records_created_last, r.records_updated_last]
        .map((x) => Number(x || 0));
      html.push(`<tr style="border-bottom:1px solid #eee" data-id="${esc(r.id)}">
        <td style="padding:6px;max-width:380px">
          <div style="font-weight:600">${esc(r.label || r.url_host || r.url)}</div>
          <div class="ads-muted" style="font-size:11px;word-break:break-all"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></div>
        </td>
        <td style="padding:6px">${esc(r.importer || "—")}</td>
        <td style="padding:6px">${statusBadge(r)}${(r.consecutive_failures || 0) > 0 ? `<div class="ads-muted" style="font-size:11px">${r.consecutive_failures}× fail</div>` : ""}</td>
        <td style="padding:6px">
          <div>${ago(r.last_run_at)}</div>
          <div class="ads-muted" style="font-size:11px">seen ${lastStats[0]} · +${lastStats[1]} new · ~${lastStats[2]} upd</div>
        </td>
        <td style="padding:6px">${esc(until(r.next_run_after))}</td>
        <td style="padding:6px">${ago(r.last_success_at)}</td>
        <td style="padding:6px">${Number(r.total_runs || 0)}<div class="ads-muted" style="font-size:11px">${Number(r.total_success || 0)}✓ ${Number(r.total_failed || 0)}✗</div></td>
        <td style="padding:6px;white-space:nowrap">
          <button class="ads-btn ads-btn--ghost" data-action="run">Run</button>
          <button class="ads-btn ads-btn--ghost" data-action="open">Details</button>
          <button class="ads-btn ads-btn--ghost" data-action="toggle">${r.enabled ? "Disable" : "Enable"}</button>
        </td>
      </tr>`);
    }
    html.push("</tbody></table>");
    $("ads-src-list").innerHTML = html.join("");

    $("ads-src-list").querySelectorAll("button[data-action]").forEach((b) => {
      b.addEventListener("click", async (e) => {
        const tr = e.target.closest("tr"); if (!tr) return;
        const id = tr.dataset.id;
        const action = b.dataset.action;
        const row = allItems.find((r) => r.id === id); if (!row) return;
        if (action === "run") {
          b.disabled = true; b.textContent = "queuing…";
          try { await jsend("POST", `/api/sources/${id}/run`); await reload(); }
          catch (err) { alert("Run failed: " + err.message); }
          finally { b.disabled = false; b.textContent = "Run"; }
        } else if (action === "open") {
          openDrawer(row);
        } else if (action === "toggle") {
          try { await jsend("PATCH", `/api/sources/${id}`, { enabled: !row.enabled }); await reload(); }
          catch (err) { alert("Update failed: " + err.message); }
        }
      });
    });
  }

  function renderStats(stats) {
    if (!stats) { $("ads-src-stats").textContent = ""; return; }
    $("ads-src-stats").innerHTML =
      `<strong>${Number(stats.total || 0)}</strong> sources · ` +
      `<strong>${Number(stats.enabled || 0)}</strong> enabled · ` +
      `<strong style="color:#a48117">${Number(stats.due || 0)}</strong> due · ` +
      `<strong style="color:#b3261e">${Number(stats.failed || 0)}</strong> failing · ` +
      `last cycle: ${Number(stats.records_last || 0)} seen, +${Number(stats.created_last || 0)} new`;
  }

  async function reload() {
    try {
      const j = await jget("/api/sources/");
      allItems = j.items || [];
      refreshFacets();
      renderStats(j.stats);
      renderList();
    } catch (e) {
      $("ads-src-list").innerHTML = `<div class="ads-muted" style="padding:16px;color:#b3261e">Failed to load: ${esc(e.message)}</div>`;
    }
  }

  // ---------- Drawer ------------------------------------------------------
  async function openDrawer(row) {
    $("ads-src-drawer").hidden = false;
    $("ads-src-drawer-title").textContent = row.label || row.url_host || row.url;
    $("ads-src-drawer-body").innerHTML = `<div class="ads-loading">Loading runs…</div>`;
    let runs = [];
    try { const j = await jget(`/api/sources/${row.id}/runs?limit=30`); runs = j.items || []; }
    catch (e) { /* */ }
    const runsHtml = runs.length === 0
      ? `<div class="ads-muted">No runs yet.</div>`
      : `<table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="text-align:left;border-bottom:1px solid #ddd">
            <th style="padding:4px">Started</th><th style="padding:4px">Status</th>
            <th style="padding:4px">Seen</th><th style="padding:4px">New</th>
            <th style="padding:4px">Upd</th><th style="padding:4px">Errs</th>
            <th style="padding:4px">Trigger</th>
          </tr></thead><tbody>
          ${runs.map((r) => `<tr style="border-bottom:1px solid #eee">
            <td style="padding:4px">${esc(fmtTime(r.started_at))}</td>
            <td style="padding:4px">${esc(r.status)}</td>
            <td style="padding:4px">${Number(r.records_seen || 0)}</td>
            <td style="padding:4px">${Number(r.records_created || 0)}</td>
            <td style="padding:4px">${Number(r.records_updated || 0)}</td>
            <td style="padding:4px">${Number(r.records_errors || 0)}${r.error_message ? ` <span class="ads-muted" title="${esc(r.error_message)}">⚠</span>` : ""}${r.job_id && (Number(r.records_errors || 0) > 0 || r.status === "failed") ? ` <a href="/dashboard/errors/?job_id=${esc(r.job_id)}" target="_blank" rel="noopener" title="View error log entries for this run">log</a>` : ""}</td>
            <td style="padding:4px">${esc(r.trigger || "")}</td>
          </tr>`).join("")}
          </tbody></table>`;

    $("ads-src-drawer-body").innerHTML = `
      <dl style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;margin:0 0 16px">
        <dt class="ads-muted">URL</dt><dd style="margin:0;word-break:break-all"><a href="${esc(row.url)}" target="_blank" rel="noopener">${esc(row.url)}</a></dd>
        <dt class="ads-muted">Importer</dt><dd style="margin:0">${esc(row.importer || "—")}</dd>
        <dt class="ads-muted">Status</dt><dd style="margin:0">${statusBadge(row)} ${row.enabled ? "" : "<em>(disabled)</em>"}</dd>
        <dt class="ads-muted">Schedule</dt><dd style="margin:0">${esc(row.schedule_cron || "default 6h")}</dd>
        <dt class="ads-muted">Added</dt><dd style="margin:0">${esc(fmtTime(row.added_at))} ${row.added_by ? `by ${esc(row.added_by)}` : ""}</dd>
        <dt class="ads-muted">Next run</dt><dd style="margin:0">${esc(fmtTime(row.next_run_after))} (${esc(until(row.next_run_after))})</dd>
        <dt class="ads-muted">Last success</dt><dd style="margin:0">${esc(fmtTime(row.last_success_at))}</dd>
        <dt class="ads-muted">Consecutive failures</dt><dd style="margin:0">${Number(row.consecutive_failures || 0)}</dd>
        ${row.notes ? `<dt class="ads-muted">Notes</dt><dd style="margin:0">${esc(row.notes)}</dd>` : ""}
      </dl>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:flex-end">
        <label class="ads-field" style="flex:1;min-width:180px"><span>Override importer</span>
          <select id="ads-src-drawer-importer">
            ${["folk","airtable","notion","google_sheets","openvc","mountside_ventures","nfx_signal","wikipedia","vcsheet","vcstack","landscape_vc","climatescape","mercury","versatilevc","jvca","golden_egg_check","map_of_the_money","founders_next_move","nyc_founder_guide","failory","generic_html","generic_jsonld"]
              .map((n) => `<option value="${esc(n)}"${n === row.importer ? " selected" : ""}>${esc(n)}</option>`).join("")}
          </select>
        </label>
        <button class="ads-btn ads-btn--ghost" data-d="save-importer">Save override</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
        <button class="ads-btn" data-d="run">Run now</button>
        <button class="ads-btn ads-btn--ghost" data-d="toggle">${row.enabled ? "Disable" : "Enable"}</button>
        <button class="ads-btn ads-btn--ghost" data-d="archive">Archive</button>
      </div>
      <h4 style="margin:12px 0 8px">Recent runs</h4>
      ${runsHtml}
    `;
    $("ads-src-drawer-body").querySelectorAll("button[data-d]").forEach((b) => {
      b.addEventListener("click", async () => {
        const a = b.dataset.d;
        try {
          if (a === "run") await jsend("POST", `/api/sources/${row.id}/run`);
          else if (a === "toggle") await jsend("PATCH", `/api/sources/${row.id}`, { enabled: !row.enabled });
          else if (a === "save-importer") {
            const sel = document.getElementById("ads-src-drawer-importer");
            const next = sel ? sel.value : row.importer;
            if (!next || next === row.importer) return;
            await jsend("PATCH", `/api/sources/${row.id}`, { importer: next });
          }
          else if (a === "archive") {
            if (!confirm("Archive this source? Run history is preserved.")) return;
            await jsend("DELETE", `/api/sources/${row.id}`);
            $("ads-src-drawer").hidden = true;
          }
          await reload();
          if (a !== "archive") {
            const fresh = allItems.find((r) => r.id === row.id);
            if (fresh) openDrawer(fresh);
          }
        } catch (e) { alert("Action failed: " + e.message); }
      });
    });
  }

  // ---------- Add modal ---------------------------------------------------
  function resetAddModal() {
    $("ads-src-add-url").value = "";
    $("ads-src-add-label").value = "";
    $("ads-src-add-importer").value = "";
    $("ads-src-add-cron").value = "";
    $("ads-src-add-detect").textContent = "";
    $("ads-src-add-preview").innerHTML = "";
    $("ads-src-add-err").textContent = "";
  }

  function wireAdd() {
    $("ads-src-add").addEventListener("click", () => { resetAddModal(); $("ads-src-add-modal").hidden = false; });
    $("ads-src-add-close").addEventListener("click", () => { $("ads-src-add-modal").hidden = true; });
    $("ads-src-add-detect-btn").addEventListener("click", async () => {
      const url = $("ads-src-add-url").value.trim();
      if (!url) return;
      try {
        const j = await jget(`/api/sources/detect?url=${encodeURIComponent(url)}`);
        $("ads-src-add-detect").innerHTML = `Detected: <strong>${esc(j.importer)}</strong> ${j.confident ? "(confident)" : "(low confidence)"} — ${esc(j.reason || "")}`;
        if (!$("ads-src-add-importer").value) $("ads-src-add-importer").value = j.importer;
      } catch (e) { $("ads-src-add-detect").textContent = "Detect failed: " + e.message; }
    });
    $("ads-src-add-preview-btn").addEventListener("click", async () => {
      const url = $("ads-src-add-url").value.trim(); if (!url) return;
      const importer = $("ads-src-add-importer").value || undefined;
      $("ads-src-add-preview").innerHTML = `<div class="ads-loading">Fetching preview…</div>`;
      try {
        const j = await jsend("POST", "/api/sources/preview", { url, importer });
        const rows = (j.firms || []).map((f) => `<tr style="border-bottom:1px solid #eee">
          <td style="padding:4px">${esc(f.name)}</td>
          <td style="padding:4px">${esc(f.website || "")}</td>
          <td style="padding:4px">${esc(f.country || "")}</td>
        </tr>`).join("");
        $("ads-src-add-preview").innerHTML =
          `<div class="ads-muted" style="font-size:12px;margin-bottom:6px">${esc(j.importer)} · saw ${Number(j.total_seen || 0)} firms${j.people_count ? `, ${j.people_count} people` : ""}</div>
           <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;border-bottom:1px solid #ddd"><th style="padding:4px">Name</th><th style="padding:4px">Website</th><th style="padding:4px">Country</th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="ads-muted" style="padding:8px">No rows previewed.</td></tr>`}</tbody></table>` +
          ((j.errors || []).length ? `<div class="ads-muted" style="font-size:11px;color:#b3261e;margin-top:6px">Errors: ${esc(j.errors.join(" · "))}</div>` : "");
      } catch (e) {
        $("ads-src-add-preview").innerHTML = `<div class="ads-muted" style="color:#b3261e">Preview failed: ${esc(e.message)}</div>`;
      }
    });
    $("ads-src-add-save").addEventListener("click", async () => {
      const url = $("ads-src-add-url").value.trim(); if (!url) { $("ads-src-add-err").textContent = "URL required"; return; }
      const body = {
        url,
        label: $("ads-src-add-label").value.trim() || null,
        importer: $("ads-src-add-importer").value || null,
        schedule_cron: $("ads-src-add-cron").value.trim() || null,
      };
      $("ads-src-add-err").textContent = "";
      try {
        await jsend("POST", "/api/sources/", body);
        $("ads-src-add-modal").hidden = true;
        await reload();
      } catch (e) { $("ads-src-add-err").textContent = "Save failed: " + e.message; }
    });
  }

  // ---------- Bootstrap event handlers -----------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    wireAdd();
    $("ads-src-drawer-close").addEventListener("click", () => { $("ads-src-drawer").hidden = true; });
    $("ads-src-refresh").addEventListener("click", reload);
    $("ads-src-q").addEventListener("input", renderList);
    $("ads-src-importer").addEventListener("change", renderList);
    $("ads-src-status").addEventListener("change", renderList);
    if ($("ads-src-category")) $("ads-src-category").addEventListener("change", renderList);
    if ($("ads-src-region")) $("ads-src-region").addEventListener("change", renderList);
    $("ads-src-run-all").addEventListener("click", async () => {
      if (!confirm("Enqueue all due sources?")) return;
      try { const j = await jsend("POST", "/api/sources/run-all", {}); alert(`Queued ${j.queued} run(s)${j.throttled ? " (throttled)" : ""}.`); await reload(); }
      catch (e) { alert("Run-all failed: " + e.message); }
    });
    $("ads-src-bootstrap").addEventListener("click", async () => {
      if (!confirm("Populate the registry from seed-sources.json? (idempotent)")) return;
      try {
        const j = await jsend("POST", "/api/sources/bootstrap");
        const errs = Array.isArray(j.errors) ? j.errors.length : 0;
        alert(`Bootstrap: ${j.created || 0} created, ${j.existing || 0} already present, ${errs} errored (of ${j.total || 0} seeds).`);
        await reload();
      }
      catch (e) { alert("Bootstrap failed: " + e.message); }
    });
    reload();
  });
})();
