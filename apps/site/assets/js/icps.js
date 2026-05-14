(function () {
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function api(p, opts) { return window.adsApiFetch(p, opts); }
  function arr(s) { return String(s || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
  function showMsg(form, text, kind) {
    var el = form.querySelector("[data-msg]"); if (!el) return;
    el.textContent = text || ""; el.className = "ads-form-msg" + (kind ? " ads-form-msg--" + kind : "");
  }

  var CURRENT_ID = null;

  async function loadList() {
    var c = document.getElementById("ads-icp-list");
    try {
      var data = await api("/api/icp/");
      var items = (data && data.items) || [];
      if (!items.length) { c.innerHTML = '<div class="ads-empty">No ICPs yet — click + New ICP.</div>'; return; }
      var html = '<table class="ads-table ads-table--clickable"><thead><tr><th>Name</th><th>Description</th><th>Sectors</th><th>Geographies</th><th>Updated</th><th></th></tr></thead><tbody>';
      items.forEach(function (i) {
        html += "<tr data-icp-id='" + esc(i.id) + "'>" +
          "<td>" + esc(i.name) + "</td>" +
          "<td class='ads-muted'>" + esc(i.description || "") + "</td>" +
          "<td class='ads-muted' style='font-size:11px'>" + esc((JSON.parse(i.sectors_json || '[]')).join(", ")) + "</td>" +
          "<td class='ads-muted' style='font-size:11px'>" + esc((JSON.parse(i.geographies_json || '[]')).join(", ")) + "</td>" +
          "<td>" + esc(new Date(i.updated_at).toLocaleString()) + "</td>" +
          "<td><button class='ads-btn ads-btn--sm' data-icp-edit='" + esc(i.id) + "'>Edit</button> " +
              "<button class='ads-btn ads-btn--sm' data-icp-preview='" + esc(i.id) + "'>Preview</button> " +
              "<button class='ads-btn ads-btn--ghost ads-btn--sm' data-icp-del='" + esc(i.id) + "'>Delete</button></td>" +
          "</tr>";
      });
      c.innerHTML = html + "</tbody></table>";
    } catch (e) { c.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; }
  }

  function openEditor(icp) {
    var card = document.getElementById("ads-icp-editor");
    var form = document.getElementById("ads-icp-form");
    document.getElementById("ads-icp-editor-title").textContent = icp ? ("Edit: " + icp.name) : "New ICP";
    form.reset();
    if (icp) {
      form.elements["id"].value = icp.id;
      form.name.value = icp.name || "";
      form.description.value = icp.description || "";
      form.sectors.value = (JSON.parse(icp.sectors_json || '[]')).join(", ");
      form.geographies.value = (JSON.parse(icp.geographies_json || '[]')).join(", ");
      form.personas.value = (JSON.parse(icp.personas_json || '[]')).join(", ");
      form.seniority.value = (JSON.parse(icp.seniority_json || '[]')).join(", ");
      form.min_aum_usd.value = icp.min_aum_usd || "";
      form.min_fund_size_usd.value = icp.min_fund_size_usd || "";
      form.min_quality.value = icp.min_quality || "";
      form.require_email.checked = !!icp.require_email;
      form.require_linkedin.checked = !!icp.require_linkedin;
      form.exclude_dnc.checked = icp.exclude_dnc !== 0;
    } else {
      form.elements["id"].value = "";
      form.exclude_dnc.checked = true;
    }
    card.style.display = "block";
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function saveIcp(e) {
    e.preventDefault();
    var form = e.target;
    var id = form.elements["id"].value;
    var body = {
      name: form.name.value,
      description: form.description.value || null,
      sectors_json: arr(form.sectors.value),
      geographies_json: arr(form.geographies.value),
      personas_json: arr(form.personas.value),
      seniority_json: arr(form.seniority.value),
      min_aum_usd: form.min_aum_usd.value ? Number(form.min_aum_usd.value) : null,
      min_fund_size_usd: form.min_fund_size_usd.value ? Number(form.min_fund_size_usd.value) : null,
      min_quality: form.min_quality.value ? Number(form.min_quality.value) : null,
      require_email: form.require_email.checked ? 1 : 0,
      require_linkedin: form.require_linkedin.checked ? 1 : 0,
      exclude_dnc: form.exclude_dnc.checked ? 1 : 0,
    };
    showMsg(form, "Saving…");
    try {
      if (id) await api("/api/icp/" + encodeURIComponent(id), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      else await api("/api/icp/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      showMsg(form, "Saved.", "ok");
      document.getElementById("ads-icp-editor").style.display = "none";
      loadList();
    } catch (err) { showMsg(form, "Failed: " + err.message, "err"); }
  }

  async function previewIcp(id) {
    CURRENT_ID = id;
    var card = document.getElementById("ads-icp-preview-card");
    var c = document.getElementById("ads-icp-preview");
    card.style.display = "block";
    c.innerHTML = '<div class="ads-loading">Matching…</div>';
    try {
      var data = await api("/api/icp/" + encodeURIComponent(id) + "/match?limit=100");
      var items = (data && data.items) || [];
      document.getElementById("ads-icp-preview-meta").textContent = "(" + (data.total || 0) + " matches, showing " + items.length + ")";
      if (!items.length) { c.innerHTML = '<div class="ads-empty">No matches.</div>'; return; }
      var html = '<table class="ads-table"><thead><tr><th>Score</th><th>Name</th><th>Org</th><th>Email</th><th>Reasons</th></tr></thead><tbody>';
      items.forEach(function (m) {
        html += "<tr><td>" + m.score.toFixed(3) + "</td><td>" + esc(m.name || "—") + "</td><td>" + esc(m.org || "—") + "</td><td>" + esc(m.email || "—") + "</td><td class='ads-muted' style='font-size:11px'>" + esc((m.reasons || []).join(", ")) + "</td></tr>";
      });
      c.innerHTML = html + "</tbody></table>";
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { c.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; }
  }

  document.addEventListener("click", async function (e) {
    var newBtn = e.target.closest("#ads-icp-new");
    if (newBtn) { openEditor(null); return; }
    var cancel = e.target.closest("#ads-icp-cancel");
    if (cancel) { document.getElementById("ads-icp-editor").style.display = "none"; return; }
    var edit = e.target.closest("button[data-icp-edit]");
    if (edit) { var r = await api("/api/icp/" + encodeURIComponent(edit.getAttribute("data-icp-edit"))); openEditor(r); return; }
    var prev = e.target.closest("button[data-icp-preview]");
    if (prev) { previewIcp(prev.getAttribute("data-icp-preview")); return; }
    var del = e.target.closest("button[data-icp-del]");
    if (del) { if (!confirm("Delete this ICP?")) return; await api("/api/icp/" + encodeURIComponent(del.getAttribute("data-icp-del")), { method: "DELETE" }); loadList(); return; }
    var make = e.target.closest("#ads-icp-make-campaign");
    if (make && CURRENT_ID) {
      var name = prompt("Campaign name?");
      if (!name) return;
      try {
        var c = await api("/api/campaigns/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name, icp_id: CURRENT_ID, channel: "email" }) });
        window.location.href = "/dashboard/campaigns/?id=" + encodeURIComponent(c.id);
      } catch (err) { alert("Failed: " + err.message); }
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    loadList();
    var form = document.getElementById("ads-icp-form");
    if (form) form.addEventListener("submit", saveIcp);
  });
})();
