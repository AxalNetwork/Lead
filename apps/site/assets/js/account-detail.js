// Task #44 — Account detail page (Overview / Buyers / Signals / Tech / History / Score).
(function () {
  var API = window.adsApiBase || "https://api.aidatasignal.com";
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmt(n) { if (n == null || isNaN(n)) return "—"; return Math.round(Number(n) * 10) / 10; }
  function api(path, opts) {
    var fn = window.adsApiFetch || function (p, o) {
      return fetch(API + p, Object.assign({ credentials: "include" }, o || {})).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
      });
    };
    return fn(path, opts);
  }
  function id() {
    var u = new URL(window.location.href); return u.searchParams.get("id") || "";
  }
  function bar(v) {
    var pct = Math.min(100, Math.max(0, Number(v || 0)));
    return '<span class="ads-bar"><span style="width:' + pct.toFixed(0) + '%"></span></span>' + fmt(v);
  }

  function renderOverview(d) {
    var a = d.account;
    var overview = document.querySelector('#ads-acct-tab-body [data-pane="overview"]');
    overview.innerHTML =
      '<dl style="display:grid;grid-template-columns:160px 1fr;gap:6px 14px;margin:0">' +
      '<dt class="ads-muted">Domain</dt><dd>' + esc(a.domain || "—") + (a.website ? ' (<a href="' + esc(a.website) + '" target="_blank">website</a>)' : "") + "</dd>" +
      '<dt class="ads-muted">Industry</dt><dd>' + esc(a.industry || "—") + (d.industries && d.industries.length ? " · " + d.industries.map(esc).join(", ") : "") + "</dd>" +
      '<dt class="ads-muted">Size</dt><dd>' + esc(a.size_band || "—") + (a.employees ? " · " + a.employees + " employees" : "") + "</dd>" +
      '<dt class="ads-muted">HQ</dt><dd>' + [a.hq_city, a.hq_region, a.hq_country_iso2].filter(Boolean).map(esc).join(", ") + "</dd>" +
      '<dt class="ads-muted">Funding</dt><dd>' + esc(a.funding_stage || "—") + "</dd>" +
      '<dt class="ads-muted">Owner</dt><dd>' + esc(a.owner_email || "—") + "</dd>" +
      '<dt class="ads-muted">Description</dt><dd>' + esc(a.description || "—") + "</dd>" +
      '<dt class="ads-muted">Last enriched</dt><dd>' + esc(a.last_enriched_at || "never") + "</dd>" +
      "</dl>";
  }
  function renderBuyers(d) {
    var pane = document.querySelector('#ads-acct-tab-body [data-pane="buyers"]');
    if (!d.buyers.length) { pane.innerHTML = '<p class="ads-muted">No buyers tracked yet.</p>'; return; }
    pane.innerHTML = '<table class="ads-table" style="width:100%;border-collapse:collapse">' +
      '<thead><tr><th align="left" style="padding:6px">Name</th><th align="left" style="padding:6px">Title</th><th align="left" style="padding:6px">Role</th><th align="left" style="padding:6px">Seniority</th><th align="right" style="padding:6px">Influence</th></tr></thead><tbody>' +
      d.buyers.map(function (b) {
        return "<tr>" +
          '<td style="padding:6px">' + esc(b.name || "—") + (b.is_decision_maker ? ' <span class="ads-chip">DM</span>' : "") + (b.is_champion ? ' <span class="ads-chip">champion</span>' : "") + "</td>" +
          '<td style="padding:6px">' + esc(b.title || "—") + "</td>" +
          '<td style="padding:6px">' + esc(b.role_slug || "—") + "</td>" +
          '<td style="padding:6px">' + esc(b.seniority || "—") + "</td>" +
          '<td style="padding:6px;text-align:right">' + fmt(b.influence_score) + "</td>" +
        "</tr>";
      }).join("") + "</tbody></table>";
  }
  function renderSignals(d) {
    var pane = document.querySelector('#ads-acct-tab-body [data-pane="signals"]');
    if (!d.signals.length) { pane.innerHTML = '<p class="ads-muted">No signals yet. Add one below.</p>'; return; }
    pane.innerHTML = '<table class="ads-table" style="width:100%;border-collapse:collapse"><thead><tr>' +
      '<th align="left" style="padding:6px">When</th><th align="left" style="padding:6px">Kind</th><th align="left" style="padding:6px">Source</th><th align="right" style="padding:6px">Weight</th><th align="right" style="padding:6px">Conf.</th><th align="left" style="padding:6px">Evidence</th></tr></thead><tbody>' +
      d.signals.map(function (s) {
        return "<tr>" +
          '<td style="padding:6px">' + esc(s.occurred_at) + "</td>" +
          '<td style="padding:6px"><span class="ads-chip">' + esc(s.kind) + "</span></td>" +
          '<td style="padding:6px">' + esc(s.source || "—") + "</td>" +
          '<td style="padding:6px;text-align:right">' + fmt(s.weight) + "</td>" +
          '<td style="padding:6px;text-align:right">' + fmt(s.confidence) + "</td>" +
          '<td style="padding:6px">' + (s.evidence_url ? '<a href="' + esc(s.evidence_url) + '" target="_blank">link</a>' : "—") + "</td>" +
        "</tr>";
      }).join("") + "</tbody></table>";
  }
  function renderTech(d) {
    var pane = document.querySelector('#ads-acct-tab-body [data-pane="tech"]');
    if (!d.tech.length) { pane.innerHTML = '<p class="ads-muted">No detected vendors.</p>'; return; }
    pane.innerHTML = d.tech.map(function (t) {
      return '<span class="ads-chip" title="' + esc(t.source || "") + '">' + esc(t.vendor) + (t.category ? " · " + esc(t.category) : "") + "</span>";
    }).join(" ");
  }
  function renderHistory(d) {
    var pane = document.querySelector('#ads-acct-tab-body [data-pane="history"]');
    if (!d.history.length) { pane.innerHTML = '<p class="ads-muted">No history yet.</p>'; return; }
    pane.innerHTML = '<table class="ads-table" style="width:100%;border-collapse:collapse"><thead><tr>' +
      '<th align="left" style="padding:6px">When</th><th align="left" style="padding:6px">Field</th><th align="left" style="padding:6px">Old → New</th><th align="left" style="padding:6px">By</th></tr></thead><tbody>' +
      d.history.map(function (h) {
        return "<tr>" +
          '<td style="padding:6px">' + esc(h.changed_at) + "</td>" +
          '<td style="padding:6px">' + esc(h.field) + "</td>" +
          '<td style="padding:6px">' + esc(h.old_value || "∅") + " → " + esc(h.new_value || "∅") + "</td>" +
          '<td style="padding:6px">' + esc(h.changed_by || h.source || "—") + "</td>" +
        "</tr>";
      }).join("") + "</tbody></table>";
  }
  function renderScore(d, score) {
    var pane = document.querySelector('#ads-acct-tab-body [data-pane="score"]');
    var s = score || {};
    var byKind = (s.intent_breakdown && s.intent_breakdown.by_kind) || [];
    pane.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
        "<div><h4>Intent</h4><p>" + bar(s.intent_score != null ? s.intent_score : d.account.intent_score) + "</p>" +
          "<p class=\"ads-muted\">Formula: 100 · (1 − exp(−Σ(weight·confidence·exp(−age_days/30)) ÷ 25))</p>" +
          (byKind.length
            ? '<table style="width:100%;border-collapse:collapse"><thead><tr><th align="left" style="padding:4px">Kind</th><th align="right" style="padding:4px">Count</th><th align="right" style="padding:4px">Contribution</th></tr></thead><tbody>' +
              byKind.map(function (k) { return "<tr><td style=\"padding:4px\">" + esc(k.kind) + "</td><td style=\"padding:4px;text-align:right\">" + esc(k.count) + "</td><td style=\"padding:4px;text-align:right\">" + esc(k.raw_contribution) + "</td></tr>"; }).join("") +
              "</tbody></table>"
            : '<p class="ads-muted">No signals contributing yet.</p>') +
        "</div>" +
        "<div><h4>Fit</h4><p>" + bar(s.fit_score != null ? s.fit_score : d.account.fit_score) + "</p>" +
          (function () {
            var fb = s.fit_breakdown || {};
            var comps = fb.components || [];
            var head = fb.icp_name ? '<p class="ads-muted">ICP: ' + esc(fb.icp_name) + ' — weighted avg of industry · size · geo · funding · buyer-role coverage.</p>' :
              '<p class="ads-muted">Weighted avg of industry · size · geo · funding · buyer-role coverage.</p>';
            if (!comps.length) return head + '<p class="ads-muted">No fit components yet.</p>';
            return head + '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
              '<th align="left" style="padding:4px">Component</th>' +
              '<th align="right" style="padding:4px">Score</th>' +
              '<th align="right" style="padding:4px">Weight</th>' +
              '<th align="left" style="padding:4px">Why</th></tr></thead><tbody>' +
              comps.map(function (c) {
                return '<tr>' +
                  '<td style="padding:4px">' + esc(c.name) + '</td>' +
                  '<td style="padding:4px;text-align:right">' + bar(c.score) + '</td>' +
                  '<td style="padding:4px;text-align:right">' + esc(c.weight) + '</td>' +
                  '<td style="padding:4px">' + esc(c.reason || '') + '</td>' +
                "</tr>";
              }).join("") + "</tbody></table>";
          })() +
          "<h4 style=\"margin-top:12px\">Account = 0.6·intent + 0.4·fit</h4><p>" + bar(s.account_score != null ? s.account_score : d.account.account_score) + "</p>" +
        "</div>" +
      "</div>";
  }

  function setStrip(d) {
    var strip = document.getElementById("ads-acct-strip");
    var a = d.account;
    strip.querySelector('[data-k="account_score"]').textContent = fmt(a.account_score);
    strip.querySelector('[data-k="intent_score"]').textContent = fmt(a.intent_score);
    strip.querySelector('[data-k="fit_score"]').textContent = fmt(a.fit_score);
    strip.querySelector('[data-k="status"]').textContent = a.status;
    document.getElementById("ads-acct-name").textContent = a.name;
    document.getElementById("ads-acct-sub").textContent = [a.industry, a.size_band, a.hq_city, a.hq_country_iso2].filter(Boolean).join(" · ") || "—";
  }
  function bindTabs() {
    var tabs = document.querySelectorAll("#ads-acct-tabs .ads-tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        document.querySelectorAll("#ads-acct-tab-body [data-pane]").forEach(function (p) { p.hidden = true; });
        document.querySelector('#ads-acct-tab-body [data-pane="' + t.dataset.tab + '"]').hidden = false;
      });
    });
  }

  function load() {
    var i = id();
    if (!i) { document.getElementById("ads-acct-name").textContent = "Missing ?id="; return; }
    api("/api/accounts/" + encodeURIComponent(i)).then(function (d) {
      setStrip(d);
      renderOverview(d); renderBuyers(d); renderSignals(d); renderTech(d); renderHistory(d);
      api("/api/accounts/" + encodeURIComponent(i) + "/score").then(function (s) { renderScore(d, s); }).catch(function () { renderScore(d, null); });
    }).catch(function (e) {
      document.getElementById("ads-acct-name").textContent = "load failed: " + e.message;
    });
  }

  function loadSignalKinds() {
    api("/api/signals/kinds").then(function (r) {
      var sel = document.getElementById("ads-acct-signal-kind");
      if (!sel) return;
      (r.kinds || []).forEach(function (k) {
        var o = document.createElement("option"); o.value = k; o.textContent = k; sel.appendChild(o);
      });
    }).catch(function () { /* ignore */ });
  }

  function bindForm() {
    var form = document.getElementById("ads-acct-add-signal");
    if (form) form.addEventListener("submit", function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var body = { kind: fd.get("kind") };
      var w = parseFloat(fd.get("weight")); if (!isNaN(w)) body.weight = w;
      var c = parseFloat(fd.get("confidence")); if (!isNaN(c)) body.confidence = c;
      var ev = fd.get("evidence_url"); if (ev) body.evidence_url = ev;
      var msg = document.getElementById("ads-acct-msg"); if (msg) msg.textContent = "saving…";
      api("/api/accounts/" + encodeURIComponent(id()) + "/signals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(function () {
        if (msg) msg.textContent = "added"; load();
      }).catch(function (e) { if (msg) msg.textContent = "failed: " + e.message; });
    });
    var enrichBtn = document.getElementById("ads-acct-enrich");
    if (enrichBtn) enrichBtn.addEventListener("click", function () {
      var msg = document.getElementById("ads-acct-msg"); if (msg) msg.textContent = "enriching…";
      api("/api/accounts/" + encodeURIComponent(id()) + "/enrich", { method: "POST" })
        .then(function (r) { if (msg) msg.textContent = "dispatched: " + (r.workflowId || "(no workflow binding)"); load(); })
        .catch(function (e) { if (msg) msg.textContent = "failed: " + e.message; });
    });
  }

  function init() { bindTabs(); bindForm(); loadSignalKinds(); load(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
