// Task #3 — OSINT identities client. Renders identities + coverage + handles
// "Run resolve now" + per-platform manual probe. Lives on the entity detail
// page (Identities tab) AND backs the candidates review page.

(function () {
  const API = (window.ADS_API_BASE || "https://api.aidatasignal.com").replace(/\/$/, "");
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    }
    for (const c of (children || [])) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }
  function escape(s) { return String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]); }
  function fmtConf(c) { const n = Number(c || 0); return (n * 100).toFixed(0) + "%"; }
  function ago(s) {
    if (!s) return "—";
    const d = new Date(s);
    if (isNaN(+d)) return s;
    const m = Math.floor((Date.now() - +d) / 60000);
    if (m < 60) return m + "m";
    if (m < 1440) return Math.floor(m / 60) + "h";
    return Math.floor(m / 1440) + "d";
  }
  async function jget(path) {
    const r = await fetch(API + path, { credentials: "include" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function jpost(path, body) {
    const r = await fetch(API + path, { method: "POST", credentials: "include", body: body ? JSON.stringify(body) : "{}" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function renderIdentities(rootId, entityId) {
    const root = document.getElementById(rootId);
    if (!root || !entityId) return;
    root.innerHTML = '<div class="ads-loading">Loading identities…</div>';
    try {
      const [info, cov] = await Promise.all([
        jget(`/api/osint/entity/${encodeURIComponent(entityId)}`),
        jget(`/api/osint/entity/${encodeURIComponent(entityId)}/coverage`),
      ]);
      root.innerHTML = "";

      // Header + run button
      const head = el("div", { class: "ads-active__head" }, [
        el("h3", null, ["Cross-platform identities"]),
        el("span", { class: "ads-muted" }, [
          `${info.handles.length} active · ${info.pending_candidates} pending · coverage ${cov.covered}/${cov.total_platforms}`,
        ]),
      ]);
      root.appendChild(head);

      const runBtn = el("button", { class: "ads-btn" }, ["Run OSINT resolve now"]);
      const msg = el("div", { class: "ads-form-msg", style: "margin:6px 0 12px 0" });
      runBtn.onclick = async () => {
        runBtn.disabled = true; runBtn.textContent = "Dispatching…"; msg.textContent = "";
        try {
          const r = await jpost(`/api/osint/entity/${encodeURIComponent(entityId)}/resolve`, {});
          msg.textContent = r.mode === "workflow"
            ? `Workflow ${r.workflow_id} dispatched — results will appear within ~60s.`
            : `Inline resolve completed: auto-linked=${r.summary.autoLinked}, queued=${r.summary.candidatesAdded}, conflicts=${r.summary.conflictsSurfaced}.`;
          setTimeout(() => renderIdentities(rootId, entityId), 2000);
        } catch (e) { msg.textContent = "Error: " + e.message; }
        finally { runBtn.disabled = false; runBtn.textContent = "Run OSINT resolve now"; }
      };
      root.appendChild(el("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:10px" }, [runBtn, msg]));

      // Coverage progress strip: "Found on N/60"
      const pct = cov.total_platforms ? Math.round((cov.covered / cov.total_platforms) * 100) : 0;
      const strip = el("div", { style: "margin:4px 0 12px 0" }, [
        el("div", { style: "display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px" }, [
          el("strong", null, [`Found on ${cov.covered}/${cov.total_platforms} platforms`]),
          el("span", { class: "ads-muted" }, [`${pct}% coverage`]),
        ]),
        el("div", { style: "height:8px;background:#eee;border-radius:4px;overflow:hidden" }, [
          el("div", { style: `height:100%;width:${pct}%;background:#43a047` }),
        ]),
      ]);
      root.appendChild(strip);

      // Handles table — with quick-reject (mark inactive) per active row.
      const tbl = el("table", { class: "ads-table", style: "width:100%" }, [
        el("thead", null, [el("tr", null, [
          el("th", null, ["Platform"]), el("th", null, ["Handle"]),
          el("th", null, ["Method"]), el("th", null, ["Confidence"]),
          el("th", null, ["Verified"]), el("th", null, ["Link"]),
          el("th", null, ["Action"]),
        ])]),
      ]);
      const tb = el("tbody");
      if (!info.handles.length) {
        tb.appendChild(el("tr", null, [el("td", { colspan: "7", class: "ads-muted" }, ["No identities resolved yet."])]));
      }
      for (const h of info.handles) {
        const rejectBtn = h.is_active ? el("button", { class: "ads-btn", style: "padding:2px 8px;font-size:11px" }, ["Reject"]) : null;
        const actionCell = el("td", null, rejectBtn ? [rejectBtn] : ["—"]);
        const row = el("tr", { style: h.is_active ? "" : "opacity:.55" }, [
          el("td", null, [h.platform]),
          el("td", null, [h.handle]),
          el("td", null, [h.link_method + (h.evidence && h.evidence.corroborations ? ` (×${h.evidence.corroborations})` : "")]),
          el("td", null, [fmtConf(h.link_confidence)]),
          el("td", { class: "ads-muted" }, [ago(h.last_verified_at) + (h.demoted_reason ? ` · demoted: ${h.demoted_reason}` : "")]),
          el("td", null, [h.url ? el("a", { href: h.url, target: "_blank", rel: "noopener" }, ["open"]) : "—"]),
          actionCell,
        ]);
        if (rejectBtn) {
          rejectBtn.onclick = async () => {
            const reason = prompt(`Reject ${h.platform}:${h.handle}? (optional reason)`);
            if (reason === null) return;
            rejectBtn.disabled = true; rejectBtn.textContent = "…";
            try {
              await jpost(`/api/osint/handles/${encodeURIComponent(h.id)}/reject`, { reason: reason || null });
              row.style.opacity = ".4"; actionCell.textContent = "rejected";
            } catch (e) {
              alert("Reject failed: " + e.message);
              rejectBtn.disabled = false; rejectBtn.textContent = "Reject";
            }
          };
        }
        tb.appendChild(row);
      }
      tbl.appendChild(tb);
      root.appendChild(tbl);

      // Pivots log
      if (info.pivots_log && info.pivots_log.length) {
        const det = el("details", { style: "margin-top:14px" }, [
          el("summary", { class: "ads-muted" }, [`Last run — ${ago(info.last_osint_run_at)} ago`]),
          el("pre", { style: "font-size:11px;background:#fafafa;padding:8px;border-radius:6px;overflow:auto" },
            [JSON.stringify(info.pivots_log, null, 2)]),
        ]);
        root.appendChild(det);
      }

      // Coverage matrix
      const covWrap = el("div", { style: "margin-top:18px" }, [el("h4", null, ["Platform coverage"])]);
      const grid = el("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px" });
      for (const m of cov.matrix) {
        const cell = el("div", {
          title: `${m.label} · ${m.category}`,
          style: `border:1px solid #e5e5e5;padding:6px 8px;border-radius:6px;font-size:12px;background:${m.active ? "#e8f5e9" : "#fafafa"};color:${m.active ? "#1b5e20" : "#666"};display:flex;justify-content:space-between;align-items:center;gap:6px`,
        }, [el("span", null, [`${m.label}${m.active ? " ✓ " + fmtConf(m.confidence) : ""}`])]);
        if (!m.active) {
          // Per-platform Probe action for missing cells — prompts for a
          // handle and POSTs /entity/:id/probe?platform=<slug>.
          const pb = el("button", { class: "ads-btn", style: "padding:1px 6px;font-size:10px" }, ["Probe"]);
          pb.onclick = async () => {
            const handle = prompt(`Probe ${m.label} for handle:`);
            if (!handle) return;
            pb.disabled = true; pb.textContent = "…";
            try {
              const r = await jpost(`/api/osint/entity/${encodeURIComponent(entityId)}/probe`, { platform: m.platform, handle: handle.trim() });
              pb.textContent = r.exists ? "✓ queued" : "✗ miss";
              if (r.exists) setTimeout(() => renderIdentities(rootId, entityId), 1500);
            } catch (e) {
              alert("Probe failed: " + e.message);
              pb.disabled = false; pb.textContent = "Probe";
            }
          };
          cell.appendChild(pb);
        }
        grid.appendChild(cell);
      }
      covWrap.appendChild(grid);
      root.appendChild(covWrap);

      // Manual probe
      const probeForm = el("div", { style: "margin-top:18px;padding:10px;border:1px dashed #ccc;border-radius:6px" }, [
        el("strong", null, ["Manual probe"]), el("br"),
        el("span", { class: "ads-muted" }, ["Hits enqueue as pending candidates (confidence 0.5)."]),
      ]);
      const platSel = el("select", { id: "ads-osint-probe-plat", style: "margin:6px 6px 0 0;padding:4px 6px" });
      for (const m of cov.matrix) platSel.appendChild(el("option", { value: m.platform }, [m.label]));
      const handleInp = el("input", { type: "text", id: "ads-osint-probe-handle", placeholder: "handle", style: "padding:4px 6px;margin:6px 6px 0 0" });
      const probeBtn = el("button", { class: "ads-btn" }, ["Probe"]);
      const probeMsg = el("div", { class: "ads-form-msg", style: "margin-top:6px" });
      probeBtn.onclick = async () => {
        probeMsg.textContent = "";
        try {
          const r = await jpost(`/api/osint/entity/${encodeURIComponent(entityId)}/probe`, { platform: platSel.value, handle: handleInp.value.trim() });
          probeMsg.textContent = r.exists ? `Found (HTTP ${r.http_status}) — queued as pending candidate.` : `Not found (HTTP ${r.http_status}).`;
        } catch (e) { probeMsg.textContent = "Error: " + e.message; }
      };
      probeForm.appendChild(platSel); probeForm.appendChild(handleInp); probeForm.appendChild(probeBtn); probeForm.appendChild(probeMsg);
      root.appendChild(probeForm);
    } catch (e) {
      root.innerHTML = `<div class="ads-error">Failed to load identities: ${escape(e.message)}</div>`;
    }
  }

  async function renderCandidates(rootId) {
    const root = document.getElementById(rootId);
    if (!root) return;
    const params = new URLSearchParams(location.search);
    const status = params.get("status") || "pending";
    const entityFilter = params.get("entity_id") || "";
    root.innerHTML = '<div class="ads-loading">Loading candidates…</div>';
    try {
      const q = new URLSearchParams({ status, limit: "200" });
      if (entityFilter) q.set("entity_id", entityFilter);
      const data = await jget(`/api/osint/candidates?${q.toString()}`);
      root.innerHTML = "";
      root.appendChild(el("div", { class: "ads-active__head" }, [
        el("h3", null, [`Candidates — ${status}`]),
        el("span", { class: "ads-muted" }, [`${data.items.length} item(s)`]),
      ]));
      if (!data.items.length) {
        root.appendChild(el("div", { class: "ads-muted" }, ["Nothing to review."]));
        return;
      }
      // Bulk-accept bar (only operates on rows with confidence > 0.90).
      const eligibleBulk = data.items.filter((x) => Number(x.link_confidence) > 0.90 && x.status === "pending");
      const selected = new Set();
      const bulkBar = el("div", { style: "display:flex;gap:10px;align-items:center;margin:8px 0 12px 0;padding:8px;background:#f5f7fa;border-radius:6px" });
      const bulkBtn = el("button", { class: "ads-btn", disabled: "true" }, ["Bulk-accept selected (0)"]);
      bulkBar.appendChild(bulkBtn);
      bulkBar.appendChild(el("span", { class: "ads-muted", style: "font-size:12px" },
        [`${eligibleBulk.length} candidate(s) above 0.90 eligible for bulk-accept.`]));
      root.appendChild(bulkBar);
      function refreshBulk() {
        bulkBtn.textContent = `Bulk-accept selected (${selected.size})`;
        bulkBtn.disabled = selected.size === 0;
      }
      bulkBtn.onclick = async () => {
        if (!selected.size) return;
        if (!confirm(`Bulk-accept ${selected.size} candidate(s)? They will be promoted to identity_handles.`)) return;
        bulkBtn.disabled = true; bulkBtn.textContent = "Working…";
        try {
          const r = await jpost(`/api/osint/candidates/bulk_accept`, { ids: [...selected] });
          const okCount = (r.results || []).filter((x) => x.ok).length;
          alert(`Bulk accept complete: ${okCount}/${r.results.length} promoted.`);
          renderCandidates(rootId);
        } catch (e) { alert("Bulk accept failed: " + e.message); refreshBulk(); }
      };

      // Two-column layout: candidates list (left) + evidence panel (right).
      const split = el("div", { style: "display:grid;grid-template-columns:1fr 380px;gap:14px" });
      const leftCol = el("div");
      const rightCol = el("div", { style: "position:sticky;top:8px;height:fit-content;border:1px solid #e5e5e5;border-radius:8px;padding:12px;background:#fafafa" }, [
        el("div", { class: "ads-muted", style: "font-size:11px;text-transform:uppercase;letter-spacing:.04em" }, ["Evidence panel"]),
        el("div", { id: "ads-osint-evidence-panel", style: "margin-top:6px;font-size:13px" }, [
          el("span", { class: "ads-muted" }, ["Click a row to inspect evidence."]),
        ]),
      ]);
      split.appendChild(leftCol); split.appendChild(rightCol);
      root.appendChild(split);

      const tbl = el("table", { class: "ads-table", style: "width:100%" }, [
        el("thead", null, [el("tr", null, [
          el("th", null, [""]),
          el("th", null, ["Entity"]), el("th", null, ["Platform"]), el("th", null, ["Handle"]),
          el("th", null, ["Method"]), el("th", null, ["Confidence"]),
          el("th", null, ["Actions"]),
        ])]),
      ]);
      const tb = el("tbody");
      function showEvidence(it) {
        const panel = document.getElementById("ads-osint-evidence-panel");
        if (!panel) return;
        panel.innerHTML = "";
        panel.appendChild(el("div", { style: "font-weight:600;margin-bottom:4px" }, [`${it.platform} · ${it.handle}`]));
        panel.appendChild(el("div", { class: "ads-muted", style: "margin-bottom:6px" },
          [`Confidence ${fmtConf(it.link_confidence)} · method ${it.link_method}`]));
        if (it.url) panel.appendChild(el("div", null, [el("a", { href: it.url, target: "_blank", rel: "noopener" }, [it.url])]));
        panel.appendChild(el("hr", { style: "margin:8px 0;border:none;border-top:1px solid #ddd" }));
        panel.appendChild(el("pre", { style: "font-size:11px;background:#fff;padding:8px;border-radius:4px;overflow:auto;max-height:260px" },
          [JSON.stringify(it.evidence ?? {}, null, 2)]));
      }
      for (const it of data.items) {
        const isBulkEligible = Number(it.link_confidence) > 0.90 && it.status === "pending";
        const cb = isBulkEligible ? el("input", { type: "checkbox" }) : null;
        if (cb) cb.addEventListener("change", () => { cb.checked ? selected.add(it.id) : selected.delete(it.id); refreshBulk(); });
        const accept = el("button", { class: "ads-btn", style: "padding:2px 8px;font-size:11px" }, ["Accept"]);
        const needs = el("button", { class: "ads-btn", style: "padding:2px 8px;font-size:11px;margin-left:4px" }, ["Needs more"]);
        const reject = el("button", { class: "ads-btn", style: "padding:2px 8px;font-size:11px;margin-left:4px" }, ["Reject"]);
        const actCell = el("td", null, [accept, needs, reject]);
        const row = el("tr", { style: "cursor:pointer" }, [
          el("td", null, [cb || el("span", { class: "ads-muted", title: "Only confidence > 0.90 is bulk-eligible" }, ["—"])]),
          el("td", null, [el("a", { href: `/dashboard/lead.html?id=${encodeURIComponent(it.entity_id)}` }, [it.entity_id.slice(0, 8) + "…"])]),
          el("td", null, [it.platform]),
          el("td", null, [it.url ? el("a", { href: it.url, target: "_blank", rel: "noopener" }, [it.handle]) : it.handle]),
          el("td", null, [it.link_method]),
          el("td", null, [fmtConf(it.link_confidence)]),
          actCell,
        ]);
        row.addEventListener("click", (e) => { if (e.target.tagName !== "BUTTON" && e.target.tagName !== "A" && e.target.tagName !== "INPUT") showEvidence(it); });
        accept.onclick = async () => {
          accept.disabled = needs.disabled = reject.disabled = true;
          try { await jpost(`/api/osint/candidates/${encodeURIComponent(it.id)}/accept`, {}); row.style.opacity = ".4"; actCell.textContent = "accepted"; selected.delete(it.id); refreshBulk(); }
          catch (e) { alert("Accept failed: " + e.message); accept.disabled = needs.disabled = reject.disabled = false; }
        };
        needs.onclick = async () => {
          const note = prompt("What additional evidence is required?") || "";
          accept.disabled = needs.disabled = reject.disabled = true;
          try { await jpost(`/api/osint/candidates/${encodeURIComponent(it.id)}/needs_evidence`, { note }); row.style.opacity = ".55"; actCell.textContent = "awaiting"; }
          catch (e) { alert("Update failed: " + e.message); accept.disabled = needs.disabled = reject.disabled = false; }
        };
        reject.onclick = async () => {
          const reason = prompt("Reject reason (optional)") || null;
          accept.disabled = needs.disabled = reject.disabled = true;
          try { await jpost(`/api/osint/candidates/${encodeURIComponent(it.id)}/reject`, { reason }); row.style.opacity = ".4"; actCell.textContent = "rejected"; selected.delete(it.id); refreshBulk(); }
          catch (e) { alert("Reject failed: " + e.message); accept.disabled = needs.disabled = reject.disabled = false; }
        };
        tb.appendChild(row);
      }
      tbl.appendChild(tb);
      leftCol.appendChild(tbl);
    } catch (e) {
      root.innerHTML = `<div class="ads-error">Failed to load: ${escape(e.message)}</div>`;
    }
  }

  window.ADSOsint = { renderIdentities, renderCandidates };
})();
