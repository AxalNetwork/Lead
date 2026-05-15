// Task #27: health dashboard.
(function () {
  const API = "https://api.aidatasignal.com";
  const $ = (id) => document.getElementById(id);
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  async function load() {
    const banner = $("ads-health-banner");
    const checksEl = $("ads-health-checks");
    banner.style.background = "#f4f4f6"; banner.style.color = "#444"; banner.textContent = "Probing…";
    try {
      const r = await fetch(API + "/api/health/deep", { credentials: "include" });
      const j = await r.json();
      const palette = { ok: ["#dcf5e3", "#0a4f1f"], degraded: ["#fff3cd", "#7a4f04"], fail: ["#f8d7da", "#7c1d24"] };
      const [bg, fg] = palette[j.status] || palette.fail;
      banner.style.background = bg; banner.style.color = fg;
      banner.textContent = "Status: " + j.status.toUpperCase();
      $("ads-health-time").textContent = new Date(j.time).toLocaleString();
      $("ads-health-err-1h").textContent = j.errors?.last_1h ?? "—";
      $("ads-health-err-24h").textContent = j.errors?.last_24h ?? "—";
      const rows = (j.checks || []).map((c) => {
        const dotColor = c.status === "ok" ? "#1f8a3a" : c.status === "degraded" ? "#a48117" : "#b3261e";
        const detail = c.error ? `error: ${c.error}` : (c.detail || "");
        return `<tr>
          <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor};margin-right:8px"></span>${esc(c.binding)} ${c.required ? '<span class="ads-muted" style="font-size:10px">[required]</span>' : ""} <span class="ads-muted" style="font-size:10px">${esc(c.status)}</span></td>
          <td style="text-align:right">${c.latency_ms}ms</td>
          <td class="ads-muted" style="font-size:12px">${esc(detail)}</td>
        </tr>`;
      }).join("");
      checksEl.innerHTML = `<table style="width:100%;font-size:13px;border-collapse:collapse">
        <thead><tr style="text-align:left;border-bottom:1px solid #eee"><th>Check</th><th style="text-align:right">Time</th><th>Detail</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    } catch (e) {
      banner.style.background = "#f8d7da"; banner.style.color = "#7c1d24";
      banner.textContent = "Health probe failed: " + e.message;
      checksEl.innerHTML = "";
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("ads-health-refresh").addEventListener("click", load);
    load();
    setInterval(load, 30000);
  });
})();
