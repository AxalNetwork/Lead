// Task #8: /dashboard/ml/evals/ — list datasets, show run history,
// trigger ad-hoc runs. Per the Jekyll static-routing constraint,
// detail uses ?id=<dataset_id> rather than a path segment.

(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => (typeof n === "number" ? n.toFixed(3) : "—");
  const fmtPct = (n) => (typeof n === "number" ? (n * 100).toFixed(1) + "%" : "—");

  async function api(path, opts) {
    const r = await fetch(path, { credentials: "include", ...(opts || {}) });
    if (!r.ok) throw new Error("api " + r.status);
    return r.json();
  }

  function sparkline(values) {
    if (!values || values.length === 0) return "";
    const w = 80, h = 18, pad = 1;
    const min = Math.min(...values), max = Math.max(...values);
    const rng = max - min || 1;
    const step = (w - pad * 2) / Math.max(1, values.length - 1);
    const pts = values.map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / rng) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return `<svg width="${w}" height="${h}" style="vertical-align:middle"><polyline fill="none" stroke="#2c6eb5" stroke-width="1.5" points="${pts}"/></svg>`;
  }

  function metricSummary(task, metrics) {
    if (!metrics) return "—";
    if (task === "page_classification" || task === "csv_mapping" || task === "role_inference") {
      return `acc ${fmtPct(metrics.accuracy)} · F1 ${fmt(metrics.f1_macro)}`;
    }
    if (task === "entity_dedupe" || task === "founder_background") {
      return `P ${fmt(metrics.precision)} R ${fmt(metrics.recall)} F1 ${fmt(metrics.f1)}` +
        (typeof metrics.brier === "number" ? ` · brier ${fmt(metrics.brier)}` : "");
    }
    if (task === "deal_extraction") {
      return `F1 ${fmt(metrics.f1)} (P ${fmt(metrics.precision)} R ${fmt(metrics.recall)})`;
    }
    return JSON.stringify(metrics);
  }

  async function renderList() {
    const data = await api("/api/ml/eval/datasets");
    const rows = (data.datasets || []).map((d) => {
      const m = d.latest_run && d.latest_run.metrics;
      const ts = d.latest_run ? new Date(d.latest_run.created_at).toLocaleString() : "—";
      return `<tr>
        <td><a href="?id=${encodeURIComponent(d.id)}">${d.task_key}</a></td>
        <td>${d.name}</td>
        <td style="text-align:right">${d.example_count}</td>
        <td>${d.latest_run ? d.latest_run.status : "—"}</td>
        <td>${metricSummary(d.task_key, m)}</td>
        <td style="font-size:11px;color:#666">${ts}</td>
        <td><button type="button" class="ads-btn ml-run-one" data-id="${d.id}" style="padding:2px 8px">Run now</button></td>
      </tr>`;
    }).join("");
    $("#ml-list").innerHTML = `<table class="ads-table" style="width:100%"><thead><tr>
      <th>Task</th><th>Name</th><th>#ex</th><th>Status</th><th>Latest metrics</th><th>Last run</th><th></th>
    </tr></thead><tbody>${rows || `<tr><td colspan="7" class="ads-muted">No datasets loaded. Click "Load bundled fixtures".</td></tr>`}</tbody></table>`;
    document.querySelectorAll(".ml-run-one").forEach((btn) => btn.addEventListener("click", async (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      e.currentTarget.disabled = true; e.currentTarget.textContent = "…";
      try {
        await api("/api/ml/eval/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataset_id: id, triggered_by: "manual" }) });
        await renderList();
      } catch (err) { alert("Run failed: " + err.message); }
    }));
  }

  async function renderDetail(id) {
    $("#ml-detail").style.display = "";
    $("#ml-detail-title").textContent = "Run history";
    const data = await api(`/api/ml/eval/datasets/${encodeURIComponent(id)}/runs`);
    const runs = data.runs || [];
    const okRuns = runs.filter((r) => r.status === "ok");
    const task = (runs[0] && runs[0].task_key) || "";
    const keyMetric = (m) => (m && (m.f1_macro ?? m.f1 ?? m.accuracy)) ?? 0;
    const series = okRuns.slice(0, 20).map((r) => keyMetric(r.metrics)).reverse();
    $("#ml-detail-meta").innerHTML = `${runs.length} runs · ${sparkline(series)}`;
    $("#ml-detail-runs").innerHTML = `<table class="ads-table" style="width:100%"><thead><tr>
      <th>When</th><th>Status</th><th>Prompt ver</th><th>Model</th><th>Metrics</th><th>#ex</th><th>Trigger</th>
    </tr></thead><tbody>${runs.map((r) => `<tr>
      <td style="font-size:11px;color:#666">${new Date(r.created_at).toLocaleString()}</td>
      <td>${r.status}${r.status_reason ? ` <span class="ads-muted">(${r.status_reason})</span>` : ""}</td>
      <td>${r.prompt_version || "—"}</td>
      <td>${r.model_version || "—"}</td>
      <td>${metricSummary(task, r.metrics)}</td>
      <td>${r.n_correct}/${r.n_examples}</td>
      <td>${r.triggered_by || "—"}</td>
    </tr>`).join("")}</tbody></table>`;
  }

  function boot() {
    $("#ml-load").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try { await api("/api/ml/eval/load-bundled", { method: "POST" }); await renderList(); }
      catch (err) { alert("Load failed: " + err.message); }
      finally { e.currentTarget.disabled = false; }
    });
    $("#ml-run-all").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true; e.currentTarget.textContent = "Running…";
      try { await api("/api/ml/eval/run-all", { method: "POST" }); await renderList(); }
      catch (err) { alert("Run-all failed: " + err.message); }
      finally { e.currentTarget.disabled = false; e.currentTarget.textContent = "Run all now"; }
    });
    renderList().catch((e) => { $("#ml-list").innerHTML = `<span class="ads-muted">Load failed: ${e.message}</span>`; });
    const id = new URLSearchParams(location.search).get("id");
    if (id) renderDetail(id).catch((e) => { $("#ml-detail-runs").innerHTML = `<span class="ads-muted">${e.message}</span>`; });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
