(function () {
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function api(p, opts) { return window.adsApiFetch(p, opts); }
  var CURRENT = null;

  async function loadList() {
    var c = document.getElementById("ads-camp-list");
    try {
      var data = await api("/api/campaigns");
      var items = (data && data.items) || [];
      if (!items.length) { c.innerHTML = '<div class="ads-empty">No campaigns yet — create one from an ICP.</div>'; return; }
      var html = '<div class="ads-table-wrap"><table class="ads-table ads-table--clickable"><thead><tr><th>Name</th><th>Channel</th><th>Status</th><th>ICP</th><th>Exported</th><th>Created</th></tr></thead><tbody>';
      items.forEach(function (i) {
        html += "<tr data-camp-id='" + esc(i.id) + "'>" +
          "<td><a href='?id=" + esc(i.id) + "'>" + esc(i.name) + "</a></td>" +
          "<td>" + esc(i.channel) + "</td>" +
          "<td><span class='ads-pill " + (i.status === "active" ? "ok" : "idle") + "'>" + esc(i.status) + "</span></td>" +
          "<td class='ads-muted' style='font-size:11px'>" + esc(i.icp_id || "—") + "</td>" +
          "<td>" + (i.exported_count || 0) + (i.exporter ? " (" + esc(i.exporter) + ")" : "") + "</td>" +
          "<td>" + esc(new Date(i.created_at).toLocaleString()) + "</td></tr>";
      });
      c.innerHTML = html + "</tbody></table></div>";
    } catch (e) { c.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; }
  }

  async function loadDetail(id) {
    CURRENT = id;
    var card = document.getElementById("ads-camp-detail");
    card.style.display = "block";
    try {
      var c = await api("/api/campaigns/" + encodeURIComponent(id));
      document.getElementById("ads-camp-detail-title").textContent = c.name;
      document.getElementById("ads-camp-meta").textContent = "Channel: " + c.channel + " · Status: " + c.status + " · ICP: " + (c.icp_id || "(none)") + " · Exported: " + (c.exported_count || 0);
      document.getElementById("ads-camp-webhook").textContent = window.adsApiBase + "/api/campaigns/" + c.id + "/webhook";
      document.getElementById("ads-camp-secret").textContent = c.webhook_secret || "(none)";
      var members = await api("/api/campaigns/" + encodeURIComponent(id) + "/members");
      renderMembers(members && members.items);
    } catch (e) { card.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; }
  }

  function renderMembers(items) {
    var c = document.getElementById("ads-camp-members");
    if (!items || !items.length) { c.innerHTML = '<div class="ads-empty">No members yet — click Preview to materialize, or Export to push.</div>'; return; }
    var html = '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Name</th><th>Email</th><th>Org</th><th>Status</th><th>Last event</th></tr></thead><tbody>';
    items.forEach(function (m) {
      html += "<tr><td>" + esc(m.name || "—") + "</td><td>" + esc(m.email || "—") + "</td><td>" + esc(m.org || "—") + "</td><td><span class='ads-pill " + (m.status === "replied" || m.status === "meeting" ? "ok" : m.status === "bounced" ? "err" : "idle") + "'>" + esc(m.status) + "</span></td><td>" + esc(m.last_event_at || "—") + "</td></tr>";
    });
    c.innerHTML = html + "</tbody></table></div>";
  }

  document.addEventListener("click", async function (e) {
    var newBtn = e.target.closest("#ads-camp-new");
    if (newBtn) {
      var name = prompt("Campaign name?");
      if (!name) return;
      var icp = prompt("ICP id (optional):") || null;
      try {
        var c = await api("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name, icp_id: icp }) });
        loadList();
        loadDetail(c.id);
      } catch (err) { window.ADS.ui.toast({ message: "Failed: " + err.message, kind: "err" }); }
      return;
    }
    var prev = e.target.closest("#ads-camp-preview");
    if (prev && CURRENT) {
      try {
        var p = await api("/api/campaigns/" + encodeURIComponent(CURRENT) + "/preview");
        window.ADS.ui.toast({ message: "Matched " + p.matched + " leads. Refreshing members…", kind: "ok" });
        loadDetail(CURRENT);
      } catch (err) { window.ADS.ui.toast({ message: "Failed: " + err.message, kind: "err" }); }
      return;
    }
    var exp = e.target.closest("#ads-camp-export");
    if (exp && CURRENT) {
      var fmt = document.getElementById("ads-camp-format").value;
      var url = window.adsApiBase + "/api/campaigns/" + encodeURIComponent(CURRENT) + "/export?format=" + encodeURIComponent(fmt);
      try {
        var res = await window.adsUtil.request(url, { method: "POST", credentials: "include" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        var blob = await res.blob();
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "campaign-" + CURRENT.slice(0, 8) + "." + (fmt === "json" ? "json" : "csv");
        a.click();
        loadDetail(CURRENT);
      } catch (err) { window.ADS.ui.toast({ message: "Export failed: " + err.message, kind: "err" }); }
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    if (!document.getElementById("ads-camp-list")) return;
    loadList();
    var qs = new URL(window.location.href).searchParams;
    var id = qs.get("id");
    if (id) loadDetail(id);
  });
})();
