// Task #8: /dashboard/ml/calibration/ — per-prediction-type Brier
// sparkline + sample-size. Deep-link via ?id=<prediction_type>.

(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => (typeof n === "number" ? n.toFixed(4) : "—");

  async function api(path) {
    const r = await fetch(path, { credentials: "include" });
    if (!r.ok) throw new Error("api " + r.status);
    return r.json();
  }

  function sparkline(values) {
    if (!values || values.length === 0) return "";
    const w = 120, h = 28, pad = 2;
    const min = Math.min(...values), max = Math.max(...values);
    const rng = max - min || 1;
    const step = (w - pad * 2) / Math.max(1, values.length - 1);
    const pts = values.map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / rng) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return `<svg width="${w}" height="${h}"><polyline fill="none" stroke="#c0392b" stroke-width="1.5" points="${pts}"/></svg>`;
  }

  async function renderList() {
    const data = await api("/api/ml/calibration");
    const byType = new Map();
    for (const r of data.rows || []) {
      const arr = byType.get(r.prediction_type) || [];
      arr.push(r); byType.set(r.prediction_type, arr);
    }
    if (byType.size === 0) {
      $("#ml-cal-list").innerHTML = `<span class="ads-muted">No graded predictions yet. The nightly calibration grader runs at 03:15 UTC and writes one row per (prediction_type, day) once predictions with closed time windows accumulate.</span>`;
      return;
    }
    const rows = Array.from(byType.entries()).map(([t, rs]) => {
      const sorted = rs.slice().sort((a, b) => a.day_bucket.localeCompare(b.day_bucket));
      const series = sorted.slice(-20).map((r) => r.brier_score || 0);
      const latest = sorted[sorted.length - 1];
      return `<tr>
        <td><a href="?id=${encodeURIComponent(t)}">${t}</a></td>
        <td>${sparkline(series)}</td>
        <td>brier ${fmt(latest.brier_score)}</td>
        <td>log-loss ${fmt(latest.log_loss)}</td>
        <td>n=${latest.sample_size}</td>
        <td style="font-size:11px;color:#666">${latest.day_bucket}</td>
      </tr>`;
    }).join("");
    $("#ml-cal-list").innerHTML = `<table class="ads-table" style="width:100%"><tbody>${rows}</tbody></table>`;
  }

  async function renderDetail(type) {
    $("#ml-cal-detail").style.display = "";
    $("#ml-cal-title").textContent = type;
    const data = await api(`/api/ml/calibration/${encodeURIComponent(type)}`);
    const rs = (data.rows || []).slice().reverse();
    const series = rs.map((r) => r.brier_score || 0);
    $("#ml-cal-spark").innerHTML = `Brier over time: ${sparkline(series)}`;
    $("#ml-cal-table").innerHTML = `<table class="ads-table" style="width:100%"><thead><tr>
      <th>Day</th><th>Sample</th><th>Brier</th><th>Log-loss</th><th>Mean pred</th><th>Mean actual</th>
    </tr></thead><tbody>${(data.rows || []).map((r) => `<tr>
      <td>${r.day_bucket}</td><td>${r.sample_size}</td>
      <td>${fmt(r.brier_score)}</td><td>${fmt(r.log_loss)}</td>
      <td>${fmt(r.mean_predicted)}</td><td>${fmt(r.mean_actual)}</td>
    </tr>`).join("")}</tbody></table>`;
  }

  function boot() {
    renderList().catch((e) => { $("#ml-cal-list").innerHTML = `<span class="ads-muted">${e.message}</span>`; });
    const id = new URLSearchParams(location.search).get("id");
    if (id) renderDetail(id).catch((e) => { $("#ml-cal-table").innerHTML = `<span class="ads-muted">${e.message}</span>`; });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
