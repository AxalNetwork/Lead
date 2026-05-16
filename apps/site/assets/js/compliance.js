(function () {
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function api(p, opts) { return window.adsApiFetch(p, opts); }
  function showMsg(form, text, kind) {
    var el = form.querySelector("[data-msg]"); if (!el) return;
    el.textContent = text || ""; el.className = "ads-form-msg" + (kind ? " ads-form-msg--" + kind : "");
  }

  async function loadDnc() {
    var c = document.getElementById("ads-dnc-list");
    try {
      var data = await api("/api/compliance/dnc");
      var items = (data && data.items) || [];
      document.getElementById("ads-dnc-meta").textContent = items.length + " entries";
      if (!items.length) { c.innerHTML = '<div class="ads-empty">DNC list is empty.</div>'; return; }
      var html = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Kind</th><th>Value</th><th>Reason</th><th>Added by</th><th>Added at</th><th></th></tr></thead><tbody>';
      items.forEach(function (r) {
        html += "<tr><td>" + esc(r.kind) + "</td><td><code>" + esc(r.value) + "</code></td><td class='ads-muted'>" + esc(r.reason || "") + "</td><td class='ads-muted' style='font-size:11px'>" + esc(r.added_by || "") + "</td><td>" + esc(new Date(r.added_at).toLocaleString()) + "</td><td><button class='ads-btn ads-btn--ghost ads-btn--sm' data-dnc-rm='" + esc(r.kind) + "|" + esc(r.value) + "'>Remove</button></td></tr>";
      });
      c.innerHTML = html + "</tbody></table></div>";
    } catch (e) { c.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; }
  }

  async function loadPii() {
    var c = document.getElementById("ads-pii-log");
    try {
      var data = await api("/api/compliance/audit/pii?limit=200");
      var items = (data && data.items) || [];
      if (!items.length) { c.innerHTML = '<div class="ads-empty">No PII access yet.</div>'; return; }
      var html = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>When</th><th>User</th><th>Lead</th><th>Fields</th><th>Reason</th><th>IP</th></tr></thead><tbody>';
      items.forEach(function (r) {
        var fields = []; try { fields = JSON.parse(r.fields_json || "[]"); } catch (e) {}
        html += "<tr><td>" + esc(new Date(r.accessed_at).toLocaleString()) + "</td><td>" + esc(r.user_email) + "</td><td><code>" + esc(r.lead_id.slice(0, 8)) + "</code></td><td class='ads-muted' style='font-size:11px'>" + esc(fields.join(", ")) + "</td><td>" + esc(r.reason || "") + "</td><td class='ads-muted' style='font-size:11px'>" + esc(r.ip || "") + "</td></tr>";
      });
      c.innerHTML = html + "</tbody></table></div>";
    } catch (e) { c.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; }
  }

  document.addEventListener("submit", async function (e) {
    if (e.target.id === "ads-dnc-form") {
      e.preventDefault();
      var form = e.target;
      var fd = new FormData(form);
      showMsg(form, "Adding…");
      try {
        await api("/api/compliance/dnc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: fd.get("kind"), value: fd.get("value"), reason: fd.get("reason") }) });
        showMsg(form, "Added.", "ok");
        form.reset();
        loadDnc();
      } catch (err) { showMsg(form, "Failed: " + err.message, "err"); }
    }
    if (e.target.id === "ads-gdpr-form") {
      e.preventDefault();
      var form = e.target;
      var fd = new FormData(form);
      var body = { email: fd.get("email") || undefined, phone: fd.get("phone") || undefined, linkedin_url: fd.get("linkedin_url") || undefined };
      if (!body.email && !body.phone && !body.linkedin_url) { showMsg(form, "Provide at least one identifier.", "err"); return; }
      if (!(await window.ADS.ui.confirmDestructive({ title: "Erase PII and DNC?", body: "All matching leads' PII will be erased and identifiers added to the Do-Not-Contact list. This is irreversible.", confirmText: "ERASE", confirmLabel: "Erase & DNC" }))) return;
      showMsg(form, "Erasing…");
      try {
        var r = await api("/api/gdpr/erase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        showMsg(form, "Erased " + (r.erased_lead_ids || []).length + " lead(s).", "ok");
        var out = document.getElementById("ads-gdpr-out");
        out.style.display = "block";
        out.textContent = JSON.stringify(r, null, 2);
        loadDnc();
      } catch (err) { showMsg(form, "Failed: " + err.message, "err"); }
    }
  });

  document.addEventListener("click", async function (e) {
    var rm = e.target.closest("button[data-dnc-rm]");
    if (!rm) return;
    var parts = rm.getAttribute("data-dnc-rm").split("|");
    if (!(await window.ADS.ui.confirm({ title: "Remove from DNC?", body: parts[0] + " " + parts[1] + " will be removed from the Do-Not-Contact list." }))) return;
    try { await api("/api/compliance/dnc", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: parts[0], value: parts[1] }) }); loadDnc(); }
    catch (err) { window.ADS.ui.toast({ message: "Failed: " + err.message, kind: "err" }); }
  });

  document.addEventListener("DOMContentLoaded", function () {
    if (!document.getElementById("ads-dnc-list")) return;
    loadDnc(); loadPii();
  });
})();
