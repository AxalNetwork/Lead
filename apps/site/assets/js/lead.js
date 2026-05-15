(function () {
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function qsId() { var p = new URLSearchParams(location.search); return p.get("id"); }

  async function api(path, init) {
    try { return await window.adsApiFetch(path, init); } catch (e) { console.warn(path, e); return null; }
  }

  function activate(name) {
    document.querySelectorAll(".ads-tab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === name); });
    document.querySelectorAll(".ads-tab-panel").forEach(function (p) {
      var on = p.getAttribute("data-tab") === name;
      p.classList.toggle("active", on);
      p.hidden = !on;
    });
  }

  async function loadDetails(id) {
    var r = await api("/api/leads/" + encodeURIComponent(id));
    var pre = document.getElementById("ads-lead-details");
    if (!r) { pre.textContent = "Lead not found."; return; }
    document.getElementById("ads-lead-title").textContent = r.full_name || r.email || ("Lead " + id.slice(0, 8));
    var sub = [r.title, r.organization, r.country_iso2].filter(Boolean).join(" · ");
    document.getElementById("ads-lead-sub").textContent = sub || "—";
    pre.textContent = JSON.stringify(r, null, 2);
  }

  async function loadHistory(id) {
    var r = await api("/api/leads/" + encodeURIComponent(id) + "/history");
    var c = document.getElementById("ads-lead-history");
    var items = (r && r.items) || [];
    if (!items.length) { c.innerHTML = '<div class="ads-empty">No history.</div>'; return; }
    var html = '<table class="ads-table"><thead><tr><th>When</th><th>Field</th><th>Old → New</th><th>Source</th></tr></thead><tbody>';
    items.forEach(function (h) {
      html += "<tr><td style='font-size:11px'>" + esc(h.changed_at) + "</td><td><code>" + esc(h.field) + "</code></td><td>" + esc(h.old_value || "—") + " → " + esc(h.new_value || "—") + "</td><td class='ads-muted'>" + esc(h.source || "") + "</td></tr>";
    });
    c.innerHTML = html + "</tbody></table>";
  }

  async function loadCampaigns(id) {
    var r = await api("/api/leads/" + encodeURIComponent(id) + "/campaigns");
    var c = document.getElementById("ads-lead-campaigns");
    var items = (r && r.items) || [];
    if (!items.length) { c.innerHTML = '<div class="ads-empty">Not in any campaign.</div>'; return; }
    var html = '<table class="ads-table"><thead><tr><th>Campaign</th><th>Status</th><th>Added</th><th>Last event</th></tr></thead><tbody>';
    items.forEach(function (m) {
      html += "<tr><td><a href='/dashboard/campaigns/?id=" + esc(m.campaign_id) + "'>" + esc(m.campaign_name || m.campaign_id) + "</a></td>"
        + "<td>" + esc(m.status || "queued") + "</td>"
        + "<td style='font-size:11px'>" + esc(m.added_at || "") + "</td>"
        + "<td style='font-size:11px'>" + esc(m.last_event_at || "") + "</td></tr>";
    });
    c.innerHTML = html + "</tbody></table>";
  }

  async function markDnc(id, reason) {
    var r = await api("/api/leads/" + encodeURIComponent(id) + "/dnc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || "operator" }),
    });
    var out = document.getElementById("ads-lead-dnc-out");
    out.style.display = "block";
    out.textContent = r ? JSON.stringify(r, null, 2) : "Failed.";
    if (r && r.ok) { await loadDetails(id); await loadHistory(id); }
  }

  // Relationships tab — resolves lead UUID -> graph entity, then mounts.
  var relMounted = false;
  async function loadRelationships(id) {
    if (relMounted) return;
    var host = document.getElementById("ads-lead-rel");
    if (!host || !window.ADSRelGraph) return;
    var detail = await api("/api/leads/" + encodeURIComponent(id));
    var name = (detail && (detail.full_name || detail.name || detail.email)) || "";
    var search = await api("/api/relationships/search?q=" + encodeURIComponent(name || id.slice(0, 8)));
    var match = ((search && search.items) || []).find(function (e) { return e.ref_table === "leads" && e.ref_id === id; });
    if (!match) { host.innerHTML = "<p class='ads-muted'>No graph entity yet — derivation runs nightly at 03:45 UTC.</p>"; relMounted = true; return; }
    window.ADSRelGraph.mount(host, { entityId: match.id, depth: 1, limit: 100, height: 480 });
    // Possible intros: shortest path from caller (resolved server-side from
    // their email) to this lead via /intros, plus top colleagues as
    // additional warm-intro candidates.
    var introsBox = document.getElementById("ads-lead-intros");
    var intros = await api("/api/relationships/intros?to=" + encodeURIComponent(id));
    var coll = await api("/api/relationships/colleagues/" + encodeURIComponent(id) + "?limit=5");
    var html = "";
    if (intros && intros.nodes && intros.nodes.length && intros.hops > 0) {
      html += "<div style='margin-bottom:6px'><strong>" + intros.hops + "-hop intro path:</strong> " +
        intros.nodes.map(function (n) { return "<span style='padding:1px 5px;background:#eef;border-radius:3px;margin-right:2px'>" + esc(n.name) + "</span>"; }).join(" → ") + "</div>";
    } else {
      html += "<p class='ads-muted' style='margin:0 0 6px'>No direct intro path from your account.</p>";
    }
    var items = (coll && coll.items) || [];
    if (items.length) {
      html += "<div><strong>Top colleagues (warm intros):</strong></div>" +
        "<ul style='margin:4px 0 0;padding-left:18px'>" +
        items.slice(0, 5).map(function (c) { return "<li><a href='/dashboard/lead/?id=" + encodeURIComponent(c.lead_id) + "'>" + esc(c.name) + "</a> · " + c.shared_firms + " shared firm" + (c.shared_firms === 1 ? "" : "s") + "</li>"; }).join("") +
        "</ul>";
    }
    introsBox.innerHTML = html;
    relMounted = true;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var id = qsId();
    if (!id) {
      var pre = document.getElementById("ads-lead-details");
      if (pre) pre.textContent = "Pass ?id=<lead_id> in the URL.";
      return;
    }
    document.querySelectorAll(".ads-tab").forEach(function (t) {
      t.addEventListener("click", function () {
        var name = t.getAttribute("data-tab");
        activate(name);
        if (name === "history") loadHistory(id);
        else if (name === "campaigns") loadCampaigns(id);
        else if (name === "relationships") loadRelationships(id);
      });
    });
    var form = document.getElementById("ads-lead-dnc-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        markDnc(id, form.elements["reason"].value);
      });
    }
    loadDetails(id);
  });
})();
