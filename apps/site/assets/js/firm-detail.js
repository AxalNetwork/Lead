// Firm detail page (Task #20). URL: /dashboard/firm-detail/?id=N
(function () {
  var root = document.getElementById("ads-firm-detail");
  if (!root) return;
  var API_BASE = (window.ADS && window.ADS.apiBase) || "https://api.aidatasignal.com";

  var firmId = Number(new URLSearchParams(window.location.search).get("id"));
  if (!Number.isFinite(firmId)) {
    root.innerHTML = '<div class="ads-card"><p class="ads-muted">Missing or invalid <code>id</code>.</p></div>';
    return;
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtMoney(n) { if (!n) return "—"; if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k"; return "$" + n; }
  function fmtArr(j) { try { var a = JSON.parse(j); return Array.isArray(a) ? a.join(", ") : ""; } catch (_) { return ""; } }

  function api(path, opts) { return fetch(API_BASE + path, Object.assign({ credentials: "include" }, opts || {})).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }

  function setupTabs() {
    var tabs = root.querySelectorAll(".ads-tab");
    var panes = root.querySelectorAll("[data-pane]");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        panes.forEach(function (p) { p.hidden = p.dataset.pane !== t.dataset.tab; });
        if (t.dataset.tab === "history") loadHistory();
        if (t.dataset.tab === "sources") loadSources();
      });
    });
  }

  function render(firm) {
    var tpl = document.getElementById("ads-firm-tpl");
    root.innerHTML = "";
    root.appendChild(tpl.content.cloneNode(true));
    setupTabs();

    var byKey = function (k) { return root.querySelector('[data-k="' + k + '"]'); };
    if (firm.logo_url) { var img = byKey("logo"); img.src = firm.logo_url; img.hidden = false; }
    byKey("name").textContent = firm.name || "—";
    byKey("kind").textContent = firm.kind || "—";
    byKey("hq").textContent = [firm.hq_city, firm.hq_region, firm.hq_country_iso2].filter(Boolean).join(", ") || "—";
    byKey("founded").textContent = firm.founded_year || "—";
    byKey("aum").textContent = fmtMoney(firm.aum_usd);
    byKey("lead_or_co").textContent = firm.lead_or_co || "—";
    if (firm.website) { var a = byKey("website"); a.textContent = firm.website.replace(/^https?:\/\//, ""); a.href = firm.website; }

    byKey("thesis").textContent = firm.thesis || "—";
    byKey("stages").textContent = fmtArr(firm.stages_json) || "—";
    byKey("sectors").textContent = fmtArr(firm.sectors_json) || "—";
    byKey("geo_focus").textContent = fmtArr(firm.geo_focus_json) || "—";
    byKey("check_typical").textContent = fmtMoney(firm.check_size_typical_usd);
    byKey("check_range").textContent = (firm.check_size_min_usd ? fmtMoney(firm.check_size_min_usd) : "?") + " – " + (firm.check_size_max_usd ? fmtMoney(firm.check_size_max_usd) : "?");
    byKey("contact_email").textContent = firm.contact_email || "—";

    var people = firm.people || [];
    byKey("people-rows").innerHTML = people.length ? people.map(function (p) {
      return "<tr>" +
        "<td>" + (p.id ? '<a href="/dashboard/lead/?id=' + p.id + '">' + esc(p.name || "—") + "</a>" : esc(p.name || "—")) + "</td>" +
        "<td>" + esc(p.role || "") + "</td>" +
        "<td>" + (p.is_decision_maker ? "✓" : "") + "</td>" +
        "<td>" + esc(p.email || "") + "</td>" +
        "<td>" + (p.linkedin_url ? '<a href="' + esc(p.linkedin_url) + '" target="_blank" rel="noopener">link</a>' : "") + "</td>" +
        "<td>" + esc(p.country_iso2 || "") + "</td>" +
        "<td>" + esc(p.last_enriched_at || "") + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="7" class="ads-muted">No team yet.</td></tr>';

    var pf = firm.portfolio || [];
    byKey("portfolio-rows").innerHTML = pf.length ? pf.map(function (p) {
      return "<tr>" +
        "<td>" + esc(p.company_name || "") + "</td>" +
        "<td>" + esc(p.company_domain || "") + "</td>" +
        "<td>" + (p.investment_year || "") + "</td>" +
        "<td>" + esc(p.stage || "") + "</td>" +
        "<td>" + fmtMoney(p.amount_usd) + "</td>" +
        "<td>" + (p.is_lead ? "lead" : "") + "</td>" +
        "<td>" + esc(p.outcome || "") + "</td>" +
        "<td>" + fmtMoney(p.exit_value_usd) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="8" class="ads-muted">No portfolio entries.</td></tr>';

    bindActions(firm);
  }

  function bindActions(firm) {
    root.querySelector('[data-act="find-team"]').addEventListener("click", function () {
      api("/api/firms/" + firm.id + "/crawl-team", { method: "POST" })
        .then(function (r) { alert("Team crawl queued (job " + r.job_id + ")."); })
        .catch(function (e) { alert("Failed: " + e.message); });
    });
    root.querySelector('[data-act="add-person"]').addEventListener("click", function () {
      var leadId = prompt("Existing lead ID (UUID):"); if (!leadId) return;
      var role = prompt("Role (e.g. 'partner'):") || "";
      api("/api/firms/" + firm.id + "/people", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId, role: role }),
      }).then(function () { window.location.reload(); }).catch(function (e) { alert("Failed: " + e.message); });
    });
    root.querySelector('[data-act="enrich"]').addEventListener("click", function () {
      // Queue the team crawl + enqueue a per-lead enrich for every linked person.
      Promise.all([
        api("/api/firms/" + firm.id + "/crawl-team", { method: "POST" }),
        Promise.all((firm.people || []).filter(function (p) { return p.id; }).map(function (p) {
          return api("/api/leads/" + p.id + "/enrich", { method: "POST" }).catch(function () { return null; });
        })),
      ]).then(function () { alert("Enrich queued for " + (firm.people || []).length + " person(s)."); });
    });
    root.querySelector('[data-act="archive"]').addEventListener("click", function () {
      if (!confirm("Archive this firm?")) return;
      fetch(API_BASE + "/api/firms/" + firm.id, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      }).then(function () { window.location.reload(); });
    });
    root.querySelector('[data-act="export"]').addEventListener("click", function () {
      window.location.href = "/dashboard/firms/?" + encodeURIComponent("q=" + (firm.name || ""));
    });
  }

  function loadHistory() {
    var tbody = root.querySelector('[data-k="history-rows"]');
    if (tbody.dataset.loaded) return;
    api("/api/firms/" + firmId + "/history").then(function (data) {
      var items = (data && data.items) || [];
      tbody.innerHTML = items.length ? items.map(function (h) {
        return "<tr>" +
          "<td>" + esc(h.changed_at) + "</td>" +
          "<td>" + esc(h.field) + "</td>" +
          "<td>" + esc(h.old_value || "") + "</td>" +
          "<td>" + esc(h.new_value || "") + "</td>" +
          "<td>" + esc(h.source || "") + "</td>" +
          "<td>" + esc(h.changed_by || "") + "</td>" +
          "</tr>";
      }).join("") : '<tr><td colspan="6" class="ads-muted">No changes recorded.</td></tr>';
      tbody.dataset.loaded = "1";
    });
  }

  function loadSources() {
    var tbody = root.querySelector('[data-k="sources-rows"]');
    if (tbody.dataset.loaded) return;
    // Pull from /api/jobs?source=<firm.domain> as a proxy: each fetch_log row
    // surfaces via the job's tier mix. We approximate by listing the most
    // recent fetch_log rows for the firm's host. The server-side route used
    // is /api/scrapers/fetch-log?host=... which already exists for diagnostics.
    var host = (window.__firmDomain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) { tbody.innerHTML = '<tr><td colspan="5" class="ads-muted">No host known.</td></tr>'; tbody.dataset.loaded = "1"; return; }
    fetch(API_BASE + "/api/scrapers/fetch-log?host=" + encodeURIComponent(host) + "&limit=50", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (data) {
        var items = (data && data.items) || [];
        tbody.innerHTML = items.length ? items.map(function (s) {
          return "<tr>" +
            "<td>" + (s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + "</a>" : "") + "</td>" +
            "<td>" + (s.tier != null ? s.tier : "") + "</td>" +
            "<td>" + esc(s.status || "") + "</td>" +
            "<td>" + esc(s.created_at || "") + "</td>" +
            "<td>" + (s.bytes != null ? s.bytes : "") + "</td>" +
            "</tr>";
        }).join("") : '<tr><td colspan="5" class="ads-muted">No fetches recorded.</td></tr>';
        tbody.dataset.loaded = "1";
      })
      .catch(function () { tbody.innerHTML = '<tr><td colspan="5" class="ads-muted">Failed to load.</td></tr>'; tbody.dataset.loaded = "1"; });
  }

  api("/api/firms/" + firmId).then(function (firm) {
    window.__firmDomain = firm.domain || (firm.website || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    document.title = (firm.name || "Firm") + " — AI Data Signal";
    render(firm);
  }).catch(function () {
    root.innerHTML = '<div class="ads-card"><p class="ads-muted">Firm not found.</p></div>';
  });
})();
