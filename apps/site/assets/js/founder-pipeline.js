// Task #5 Founder Pipeline UI.
//
// Kanban of investor cards with reputation badges + suggested-next-investors
// panel pulled from the intro routing engine. Per the Task #4 static-routing
// constraint, deep links use ?id=<pipeline_id>.

(function () {
  const API = "https://api.aidatasignal.com";
  const STAGES = [
    "not_contacted","intro_requested","first_meeting","diligence",
    "partners_meeting","term_sheet","committed","passed","ghosted",
  ];
  const STAGE_LABELS = {
    not_contacted:"Not contacted", intro_requested:"Intro requested",
    first_meeting:"First meeting",  diligence:"Diligence",
    partners_meeting:"Partners",    term_sheet:"Term sheet",
    committed:"Committed", passed:"Passed", ghosted:"Ghosted",
  };

  const $ = (id) => document.getElementById(id);
  const fetchJson = (path, opts) => fetch(API + path, Object.assign({
    credentials: "include", headers: { "Content-Type": "application/json" },
  }, opts || {})).then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, body: j })));

  const url = new URL(location.href);
  let pipelineId = url.searchParams.get("id");

  async function loadPipelines() {
    const r = await fetchJson("/api/founder-pipelines");
    return r.ok ? (r.body.items || []) : [];
  }

  async function init() {
    const pipelines = await loadPipelines();
    if (!pipelines.length) {
      $("fp-no-pipeline").hidden = false;
      $("fp-create-form").addEventListener("submit", onCreate);
      return;
    }
    if (!pipelineId) {
      pipelineId = pipelines[0].id;
      url.searchParams.set("id", pipelineId);
      history.replaceState({}, "", url.toString());
    }
    const picker = $("fp-picker");
    picker.innerHTML = pipelines.map((p) =>
      `<option value="${p.id}"${p.id===pipelineId?" selected":""}>${esc(p.raise_purpose)}</option>`,
    ).join("");
    picker.addEventListener("change", () => { location.search = "?id=" + picker.value; });
    $("fp-add-investor").addEventListener("click", onAddInvestor);
    await renderPipeline();
    await renderSuggestions();
  }

  async function onCreate(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await fetchJson("/api/founder-pipelines", {
      method: "POST",
      body: JSON.stringify({
        raise_purpose: f.get("raise_purpose"),
        target_round: f.get("target_round") || null,
        target_amount_usd: f.get("target_amount_usd") ? Number(f.get("target_amount_usd")) : null,
        founder_entity_id: f.get("founder_entity_id") || null,
      }),
    });
    if (r.ok) location.search = "?id=" + r.body.id;
    else alert("Could not create pipeline: " + (r.body.error || r.status));
  }

  async function onAddInvestor() {
    const id = prompt("Investor entity ID (ent_…)");
    if (!id) return;
    const r = await fetchJson(`/api/founder-pipelines/${pipelineId}/investors`, {
      method: "POST",
      body: JSON.stringify({ investor_entity_id: id.trim() }),
    });
    if (r.ok) await renderPipeline();
    else alert("Could not add investor: " + (r.body.error || r.status));
  }

  async function renderPipeline() {
    const r = await fetchJson(`/api/founder-pipelines/${encodeURIComponent(pipelineId)}`);
    if (!r.ok) { $("fp-header").innerHTML = "<p>Pipeline not found.</p>"; $("fp-header").hidden = false; return; }
    const p = r.body.pipeline; const cards = r.body.investors || [];
    $("fp-purpose").textContent = p.raise_purpose;
    $("fp-round").textContent  = p.target_round  ? " · " + p.target_round  : "";
    $("fp-amount").textContent = p.target_amount_usd ? " · $" + Number(p.target_amount_usd).toLocaleString() : "";
    $("fp-header").hidden = false;

    // Fetch reputation badges in parallel for every distinct investor.
    const reps = {};
    await Promise.all(Array.from(new Set(cards.map((c) => c.investor_entity_id))).map(async (id) => {
      const rep = await fetchJson(`/api/investors/${encodeURIComponent(id)}/reputation`);
      if (rep.ok) reps[id] = rep.body;
    }));

    const board = $("fp-kanban");
    board.hidden = false;
    board.innerHTML = STAGES.map((s) => {
      const col = cards.filter((c) => c.stage === s);
      const inner = col.map((c) => renderCard(c, reps[c.investor_entity_id])).join("");
      return `<div class="col" data-stage="${s}"><h4>${STAGE_LABELS[s]} (${col.length})</h4>${inner}</div>`;
    }).join("");

    board.querySelectorAll(".card select.stage").forEach((sel) => {
      sel.addEventListener("change", () => onStageChange(sel.dataset.id, sel.value, sel.dataset.from));
    });
  }

  function renderCard(c, rep) {
    const name = (rep && rep.display_name) || c.investor_entity_id;
    const badges = renderBadges(rep);
    const options = STAGES.map((s) =>
      `<option value="${s}"${s===c.stage?" selected":""}>${STAGE_LABELS[s]}</option>`,
    ).join("");
    return `
      <div class="card">
        <div class="name">${esc(name)}</div>
        <select class="stage" data-id="${c.id}" data-from="${c.stage}">${options}</select>
        <div class="badges">${badges}</div>
        ${c.next_step ? `<div class="ads-muted" style="margin-top:4px">Next: ${esc(c.next_step)}</div>` : ""}
      </div>`;
  }

  function renderBadges(rep) {
    if (!rep) return `<span class="badge muted">no reputation</span>`;
    const out = [];
    if (rep.low_sample) {
      out.push(`<span class="badge muted">low sample (${rep.sample_size||0} reviews)</span>`);
    } else {
      if (rep.founder_nps != null)              out.push(`<span class="badge">NPS ${Math.round(rep.founder_nps)}</span>`);
      if (rep.speed_to_no_days_median != null)  out.push(`<span class="badge">${rep.speed_to_no_days_median}d to no</span>`);
      if (rep.reneged_term_sheets_count)        out.push(`<span class="badge warn">${rep.reneged_term_sheets_count} reneged</span>`);
    }
    if (rep.follow_on_rate_pct != null)         out.push(`<span class="badge">${Math.round(rep.follow_on_rate_pct*100)}% follow-on</span>`);
    if (rep.term_aggressiveness_pct != null)    out.push(`<span class="badge">${Math.round(rep.term_aggressiveness_pct*100)}p aggressive</span>`);
    return out.join("");
  }

  async function onStageChange(invId, toStage, fromStage) {
    if (toStage === fromStage) return;
    const r = await fetchJson(
      `/api/founder-pipelines/${encodeURIComponent(pipelineId)}/investors/${encodeURIComponent(invId)}`,
      { method: "PATCH", body: JSON.stringify({ stage: toStage }) },
    );
    if (!r.ok) { alert("Stage update failed: " + (r.body.error || r.status)); return; }
    await renderPipeline();
  }

  async function renderSuggestions() {
    const r = await fetchJson(`/api/founder-pipelines/${encodeURIComponent(pipelineId)}/suggestions`);
    if (!r.ok) return;
    $("fp-suggestions-card").hidden = false;
    const items = r.body.items || [];
    $("fp-suggestions-meta").textContent = r.body.founder_entity_id
      ? `Top ${items.length} candidates ranked by reputation; intro hops shown when path exists.`
      : `Founder entity not resolved — intro routing unavailable. Showing reputation-only suggestions.`;
    if (!items.length) { $("fp-suggestions").innerHTML = "<p>No suggestions yet.</p>"; return; }
    $("fp-suggestions").innerHTML = items.map((s) => {
      const rep = s.reputation || {};
      const lowSample = !rep.is_public;
      return `<div class="card" style="margin-bottom:8px">
        <div class="name">${esc(s.display_name || s.investor_entity_id)}</div>
        <div class="badges">
          ${lowSample ? `<span class="badge muted">${rep.sample_size||0} reviews</span>`
                     : `<span class="badge">NPS ${Math.round(rep.founder_nps||0)}</span>`}
          ${rep.follow_on_rate_pct != null ? `<span class="badge">${Math.round(rep.follow_on_rate_pct*100)}% follow-on</span>` : ""}
          ${s.intro_hops != null ? `<span class="badge">${s.intro_hops} hops</span>` : `<span class="badge muted">no path</span>`}
        </div>
      </div>`;
    }).join("");
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]
  )); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
