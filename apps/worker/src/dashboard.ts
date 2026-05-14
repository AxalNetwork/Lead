export function renderDashboard(email: string): Response {
  const safeEmail = email.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — AI Data Signal</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0b1020;--panel:#121933;--panel-2:#1a2347;--border:#243066;
    --text:#e6ebff;--muted:#8b94c2;--accent:#5b8cff;--accent-2:#23d6a4;--warn:#ffb547;--danger:#ff5d6c;
  }
  html,body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
  a{color:var(--accent);text-decoration:none}
  .topbar{background:#070b1c;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50}
  .topbar-inner{max-width:1400px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:32px}
  .brand{font-weight:700;font-size:18px;color:#fff;display:flex;align-items:center;gap:10px}
  .brand-dot{width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-2))}
  .nav{display:flex;gap:6px;flex:1;margin-left:24px}
  .nav a{padding:8px 14px;border-radius:8px;color:var(--muted);font-weight:500;font-size:14px}
  .nav a:hover{color:#fff;background:var(--panel)}
  .nav a.active{color:#fff;background:var(--panel-2)}
  .user{display:flex;align-items:center;gap:14px;font-size:13px;color:var(--muted)}
  .logout{color:var(--muted)}.logout:hover{color:var(--danger)}
  main{max-width:1400px;margin:0 auto;padding:32px 24px}
  h1{font-size:24px;font-weight:600;margin:0 0 6px}
  .sub{color:var(--muted);margin:0 0 28px;font-size:14px}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;font-size:13px;border:none;cursor:pointer}
  .btn:hover{filter:brightness(1.1);color:#fff}
  .btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin-bottom:32px}
  @media(max-width:1100px){.grid{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:640px){.grid{grid-template-columns:1fr}}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px}
  .kpi-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px}
  .kpi-value{font-size:32px;font-weight:700;color:#fff}
  .section{display:grid;grid-template-columns:2fr 1fr;gap:18px;margin-bottom:32px}
  @media(max-width:1100px){.section{grid-template-columns:1fr}}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 12px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border)}
  td{padding:12px;border-bottom:1px solid var(--border)}
  tr:last-child td{border-bottom:none}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
  .pill.ok{background:rgba(35,214,164,.12);color:var(--accent-2)}
  .pill.warn{background:rgba(255,181,71,.12);color:var(--warn)}
  .pill.err{background:rgba(255,93,108,.12);color:var(--danger)}
  .pill.idle{background:rgba(139,148,194,.12);color:var(--muted)}
  .card h3{margin:0 0 16px;font-size:14px;font-weight:600;color:#fff}
  .empty{color:var(--muted);text-align:center;padding:24px;font-size:13px}
  .loading{color:var(--muted);font-size:13px}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a href="/" class="brand"><span class="brand-dot"></span> AI Data Signal</a>
    <nav class="nav">
      <a href="/" class="active">Dashboard</a>
      <a href="/jobs">Jobs</a>
      <a href="/review">Review</a>
      <a href="/sources">Sources</a>
      <a href="/exports">Exports</a>
    </nav>
    <div class="user">
      <span>${safeEmail}</span>
      <a href="https://axalnetwork.cloudflareaccess.com/cdn-cgi/access/logout" class="logout">Sign out</a>
    </div>
  </div>
</header>

<main>
  <h1>Admin Dashboard</h1>
  <p class="sub">Live overview of your lead intelligence pipeline.</p>

  <div class="actions">
    <a href="/jobs/new" class="btn">+ New Scrape Job</a>
    <a href="/review" class="btn btn-ghost">Review Queue</a>
    <button class="btn btn-ghost" id="export-btn">Export CSV</button>
  </div>

  <div class="grid">
    <div class="card"><div class="kpi-label">Total Leads</div><div class="kpi-value" data-kpi="total_leads">—</div></div>
    <div class="card"><div class="kpi-label">Verified</div><div class="kpi-value" data-kpi="verified_leads">—</div></div>
    <div class="card"><div class="kpi-label">Approved</div><div class="kpi-value" data-kpi="approved_leads">—</div></div>
    <div class="card"><div class="kpi-label">Pending Review</div><div class="kpi-value" data-kpi="pending_leads">—</div></div>
    <div class="card"><div class="kpi-label">Active Jobs</div><div class="kpi-value" data-kpi="active_jobs">—</div></div>
    <div class="card"><div class="kpi-label">Exports / week</div><div class="kpi-value" data-kpi="exports_count">—</div></div>
    <div class="card"><div class="kpi-label">Verification Rate</div><div class="kpi-value" data-kpi="verification_rate">—</div></div>
    <div class="card"><div class="kpi-label">Job Success Rate</div><div class="kpi-value" data-kpi="job_success_rate">—</div></div>
  </div>

  <div class="section">
    <div class="card"><h3>Recent Leads</h3><div id="recent-leads"><div class="loading">Loading…</div></div></div>
    <div class="card"><h3>Top Source Domains</h3><div id="top-sources"><div class="loading">Loading…</div></div></div>
  </div>

  <div class="section">
    <div class="card"><h3>Recent Jobs</h3><div id="recent-jobs"><div class="loading">Loading…</div></div></div>
    <div class="card"><h3>Leads by Category</h3><div id="leads-by-category"><div class="loading">Loading…</div></div></div>
  </div>
</main>

<script>
const API_BASE = "https://api.aidatasignal.com";
const fmtPct = n => n==null?"—":(Math.round(n*1000)/10)+"%";
const fmtInt = n => n==null?"—":new Intl.NumberFormat("en-US").format(n);
const setKpi = (k,v) => { const e=document.querySelector('[data-kpi="'+k+'"]'); if(e) e.textContent=v; };

async function api(p) {
  try {
    const r = await fetch(API_BASE+p, { credentials: "include" });
    if (!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  } catch (e) { console.warn("API",p,e); return null; }
}

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
  if (children != null) {
    if (Array.isArray(children)) children.forEach(ch => e.appendChild(typeof ch === "string" ? document.createTextNode(ch) : ch));
    else e.textContent = String(children);
  }
  return e;
}
function buildTable(headers, rows) {
  const table = el("table");
  const thead = el("thead");
  const trh = el("tr");
  headers.forEach(h => trh.appendChild(el("th", null, h)));
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = el("tbody");
  rows.forEach(cells => {
    const tr = el("tr");
    cells.forEach(cell => {
      const td = el("td");
      if (cell && cell.nodeType === 1) td.appendChild(cell);
      else td.textContent = cell == null ? "—" : String(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}
function pill(text, cls) { return el("span", { class: "pill " + cls }, String(text || "")); }
function statusCls(s, mapping) { return mapping[s] || "idle"; }
function setContent(id, node) { const c = document.getElementById(id); c.textContent = ""; c.appendChild(node); }
function setEmpty(id, msg) { const c = document.getElementById(id); c.textContent = ""; c.appendChild(el("div", { class: "empty" }, msg)); }

function renderLeads(items) {
  if (!items || !items.length) return setEmpty("recent-leads", "No leads yet.");
  const map = { approved: "ok", pending: "warn", flagged: "err" };
  const rows = items.map(l => [l.name || "—", l.org || "—", l.source_domain || "—", pill(l.status || "new", statusCls(l.status, map))]);
  setContent("recent-leads", buildTable(["Name","Org","Source","Status"], rows));
}
function renderSources(items) {
  if (!items || !items.length) return setEmpty("top-sources", "No source data yet.");
  setContent("top-sources", buildTable(["Domain","Leads"], items.map(s => [s.domain, fmtInt(s.lead_count)])));
}
function renderJobs(items) {
  if (!items || !items.length) return setEmpty("recent-jobs", "No jobs yet.");
  const map = { completed: "ok", running: "warn", failed: "err" };
  const rows = items.map(j => [j.name || j.id, j.source || "—", pill(j.status || "queued", statusCls(j.status, map)), j.started_at ? new Date(j.started_at).toLocaleString() : "—"]);
  setContent("recent-jobs", buildTable(["Job","Source","Status","Started"], rows));
}
function renderCats(items) {
  if (!items || !items.length) return setEmpty("leads-by-category", "No categories yet.");
  setContent("leads-by-category", buildTable(["Category","Leads"], items.map(x => [x.category, fmtInt(x.count)])));
}

(async () => {
  const summary = await api("/api/analytics/summary");
  if (summary) {
    setKpi("total_leads", fmtInt(summary.total_leads));
    setKpi("verified_leads", fmtInt(summary.verified_leads));
    setKpi("approved_leads", fmtInt(summary.approved_leads));
    setKpi("pending_leads", fmtInt(summary.pending_leads));
    setKpi("active_jobs", fmtInt(summary.active_jobs));
    setKpi("exports_count", fmtInt(summary.exports_count));
    setKpi("verification_rate", fmtPct(summary.verification_rate));
    setKpi("job_success_rate", fmtPct(summary.job_success_rate));
    renderLeads(summary.recent_leads);
    renderJobs(summary.recent_jobs);
    renderCats(summary.leads_by_category);
  } else {
    setEmpty("recent-leads","API unavailable.");
    setEmpty("recent-jobs","API unavailable.");
    setEmpty("leads-by-category","API unavailable.");
  }
  const sources = await api("/api/analytics/sources");
  renderSources(sources && sources.items);
})();

document.getElementById("export-btn").addEventListener("click", () => {
  window.location.href = API_BASE + "/api/exports/csv";
});
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}
