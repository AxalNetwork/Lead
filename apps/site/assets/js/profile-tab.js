// Task #3: Profile tab — embeddable on any detail page + standalone /dashboard/profile/.
//
// Public surface (mirrors news-tab.js):
//   window.ADS.Profile.mount({ rootId, entityId })  — embed mode
//   window.ADS.Profile.mountStandalone()            — /dashboard/profile/
//
// Resolves entity via ?entity=<id> or ?table=&ref= (same convention as DD/News).

(function () {
  if (window.ADS && window.ADS.Profile) return;
  window.ADS = window.ADS || {};

  var API = (window.ADS_API_BASE).replace(/\/+$/, "");

  var AXIS_LABELS = {
    left_right: ["Far left", "Center", "Far right"],
    lib_auth:   ["Libertarian", "Mixed", "Authoritarian"],
    prog_cons:  ["Progressive", "Moderate", "Conservative"],
    glob_nat:   ["Globalist", "Mixed", "Nationalist"],
    sec_rel:    ["Secular", "Mixed", "Religious"],
  };
  var AXIS_TITLES = {
    left_right: "Left ↔ Right",
    lib_auth:   "Libertarian ↔ Authoritarian",
    prog_cons:  "Progressive ↔ Conservative",
    glob_nat:   "Globalist ↔ Nationalist",
    sec_rel:    "Secular ↔ Religious",
  };

  function qs() {
    var p = new URLSearchParams(window.location.search);
    return { entity: p.get("entity"), table: p.get("table"), ref: p.get("ref") };
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  async function api(path, init) {
    init = init || {};
    init.credentials = init.credentials || "include";
    init.headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
    var res = await fetch(API + path, init);
    if (!res.ok) throw new Error(path + " -> " + res.status);
    return res.json();
  }
  async function resolveEntityId(qstate) {
    if (qstate.entity) return qstate.entity;
    if (qstate.table && qstate.ref) {
      try {
        var r = await api("/api/entities/resolve?table=" + encodeURIComponent(qstate.table) + "&ref=" + encodeURIComponent(qstate.ref));
        return r.entity_id || r.id || null;
      } catch (_) { return null; }
    }
    return null;
  }

  // -1..+1 → [0..100]% position on a horizontal bar.
  function axisBar(name, value, manual) {
    var title = AXIS_TITLES[name] || name;
    var labels = AXIS_LABELS[name] || ["—", "—", "—"];
    if (value === null || value === undefined) {
      return '<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ads-muted)"><span>' + esc(title) + '</span><span>—</span></div><div style="height:6px;background:#eee;border-radius:3px;margin-top:3px"></div><div style="font-size:10px;color:var(--ads-muted);margin-top:2px">Insufficient evidence.</div></div>';
    }
    var pct = Math.round(((value + 1) / 2) * 100);
    var sign = value > 0 ? "+" : "";
    var manualBadge = manual ? ' <span style="background:#7a5a00;color:#fff;font-size:9px;padding:0 4px;border-radius:6px;margin-left:4px">PINNED</span>' : "";
    return '<div style="margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ads-text)"><span>' + esc(title) + manualBadge + '</span><span><strong>' + sign + value.toFixed(2) + '</strong></span></div>' +
      '<div style="position:relative;height:6px;background:linear-gradient(to right,#2c6eb5,#ddd,#a33);border-radius:3px;margin-top:3px">' +
        '<div style="position:absolute;left:' + pct + '%;top:-3px;width:2px;height:12px;background:#111"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ads-muted);margin-top:1px"><span>' + esc(labels[0]) + '</span><span>' + esc(labels[2]) + '</span></div>' +
    '</div>';
  }

  function influenceBar(label, value) {
    var pct = Math.round((value || 0) * 100);
    return '<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:11px"><span>' + esc(label) + '</span><span><strong>' + pct + '%</strong></span></div>' +
      '<div style="height:6px;background:#eee;border-radius:3px"><div style="height:100%;width:' + pct + '%;background:#2c6eb5;border-radius:3px"></div></div></div>';
  }

  function typeChips(weights) {
    if (!weights) return '<span class="ads-muted">—</span>';
    var entries = Object.entries(weights).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6);
    return entries.map(function (e) {
      var pct = Math.round(e[1] * 100);
      return '<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;background:#f0f6ff;border:1px solid #d0e0f5;border-radius:10px;font-size:11px">' + esc(e[0]) + ' <strong>' + pct + '%</strong></span>';
    }).join("");
  }
  function listChips(arr) {
    if (!Array.isArray(arr) || !arr.length) return '<span class="ads-muted">—</span>';
    return arr.slice(0, 12).map(function (x) {
      var weight = typeof x.weight === "number" ? Math.round(x.weight * 100) + "%" : "";
      return '<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;background:#fafafa;border:1px solid #e0e0e0;border-radius:10px;font-size:11px">' + esc(x.label) + (weight ? ' <span style="color:#888">' + weight + '</span>' : '') + '</span>';
    }).join("");
  }

  function flagChip(label, on, color) {
    if (!on) return "";
    return '<span style="display:inline-block;padding:2px 8px;background:' + color + ';color:#fff;border-radius:10px;font-size:11px;margin-right:6px;font-weight:600">' + esc(label) + '</span>';
  }

  function appointmentsTable(items) {
    if (!items.length) return '<div class="ads-muted" style="font-size:12px">No government appointments on file.</div>';
    return '<table class="ads-table" style="width:100%;font-size:12px"><thead><tr><th>Role</th><th>Body</th><th>Jurisdiction</th><th>Party</th><th>From</th><th>To</th><th>Source</th></tr></thead><tbody>' +
      items.map(function (a) {
        return '<tr>' +
          '<td><strong>' + esc(a.title) + '</strong>' + (a.is_current ? ' <span style="background:#1a7a35;color:#fff;font-size:9px;padding:0 4px;border-radius:6px">CURRENT</span>' : '') + '</td>' +
          '<td>' + esc(a.body || "—") + '</td>' +
          '<td>' + esc(a.jurisdiction || "—") + '</td>' +
          '<td>' + esc(a.party || "—") + '</td>' +
          '<td>' + esc(a.start_date || "—") + '</td>' +
          '<td>' + esc(a.end_date || (a.is_current ? "present" : "—")) + '</td>' +
          '<td>' + (a.source_url ? '<a href="' + esc(a.source_url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.source) + '</a>' : esc(a.source || "—")) + '</td>' +
        '</tr>';
      }).join("") +
    '</tbody></table>';
  }

  function donationsAggTable(items) {
    if (!items.length) return '<div class="ads-muted" style="font-size:12px">No political donations on file.</div>';
    return '<table class="ads-table" style="width:100%;font-size:12px"><thead><tr><th>Party / Recipient kind</th><th>Donations</th><th>Total USD</th></tr></thead><tbody>' +
      items.map(function (d) {
        var total = d.total != null ? d.total.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : "—";
        return '<tr><td>' + esc(d.recipient_party || "—") + '</td><td>' + esc(d.n) + '</td><td>' + esc(total) + '</td></tr>';
      }).join("") +
    '</tbody></table>';
  }

  function renderProfile(host, data, state) {
    var manual = data.manual_overrides || {};
    var idHtml = data.ideology
      ? ["left_right","lib_auth","prog_cons","glob_nat","sec_rel"].map(function (k) { return axisBar(k, data.ideology[k], !!manual[k]); }).join("")
      : '<div class="ads-muted">Ideology axes disabled.</div>';

    host.innerHTML = (
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' +
        '<div class="ads-card">' +
          '<div class="ads-active__head"><h3>Type</h3>' +
            (data.primary_type ? '<span style="font-size:12px"><strong>' + esc(data.primary_type) + '</strong> · ' + Math.round((data.primary_type_conf || 0) * 100) + '% conf' + (manual.primary_type ? ' <span style="background:#7a5a00;color:#fff;font-size:9px;padding:0 4px;border-radius:6px">PINNED</span>' : '') + '</span>' : '<span class="ads-muted">Not classified</span>') +
          '</div>' +
          '<div style="margin-top:6px">' + typeChips(data.type_weights) + '</div>' +
          '<div style="margin-top:10px;display:flex;flex-wrap:wrap">' +
            flagChip("PEP", data.flags && data.flags.is_pep, "#a33") +
            flagChip("GOV OFFICIAL", data.flags && data.flags.is_government_official, "#1a3a6b") +
            flagChip("LOBBYIST", data.flags && data.flags.is_lobbyist, "#7a5a00") +
          '</div>' +
        '</div>' +
        '<div class="ads-card">' +
          '<div class="ads-active__head"><h3>Influence</h3><span class="ads-muted" style="font-size:11px">Derived, not AI</span></div>' +
          (data.influence
            ? influenceBar("Political", data.influence.political_influence) +
              influenceBar("Media",     data.influence.media_influence) +
              influenceBar("Network",   data.influence.network_centrality) +
              influenceBar("Capital",   data.influence.capital_influence)
            : '<span class="ads-muted">—</span>') +
        '</div>' +
      '</div>' +

      '<div class="ads-card" style="margin-top:14px">' +
        '<div class="ads-active__head"><h3>Ideology</h3><span class="ads-muted" style="font-size:11px">' +
          (data.ideology && data.ideology.confidence != null ? 'Overall confidence ' + Math.round(data.ideology.confidence * 100) + '%' : 'No confidence — null axes indicate no public evidence') +
        '</span></div>' +
        '<div style="margin-top:8px">' + idHtml + '</div>' +
        '<div style="margin-top:8px;font-size:11px;color:var(--ads-muted)">Inferred from public statements and donations. May not reflect current views. Null = no evidence (we never default to centrist). Pinned values were set by an operator.</div>' +
      '</div>' +

      '<div class="ads-card" style="margin-top:14px">' +
        '<div class="ads-active__head"><h3>Public-persona summary</h3>' +
          (data.classifier_version ? '<span class="ads-muted" style="font-size:11px">v ' + esc(data.classifier_version) + (data.classified_at ? ' · ' + esc(new Date(data.classified_at).toLocaleDateString()) : '') + '</span>' : '') +
        '</div>' +
        '<div style="margin-top:6px;font-size:13px;line-height:1.55;white-space:pre-wrap">' + esc(data.summary || "No summary yet — run a classification.") + '</div>' +
      '</div>' +

      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-top:14px">' +
        '<div class="ads-card"><h3 style="margin:0 0 6px;font-size:13px">Interests</h3>' + listChips(data.interests) + '</div>' +
        '<div class="ads-card"><h3 style="margin:0 0 6px;font-size:13px">Hobbies</h3>' + listChips(data.hobbies) + '</div>' +
        '<div class="ads-card"><h3 style="margin:0 0 6px;font-size:13px">Causes</h3>' + listChips(data.causes) + '</div>' +
      '</div>' +

      '<div class="ads-card" style="margin-top:14px">' +
        '<div class="ads-active__head"><h3>Government appointments</h3>' +
          '<button class="ads-btn" data-act="refresh-gov" style="font-size:11px;padding:2px 8px" type="button">Refresh sources</button>' +
        '</div>' +
        '<div class="ads-table-wrap" style="margin-top:6px">' + appointmentsTable(data.appointments || []) + '</div>' +
      '</div>' +

      '<div class="ads-card" style="margin-top:14px">' +
        '<div class="ads-active__head"><h3>Political donations</h3>' +
          '<a class="ads-btn" style="font-size:11px;padding:2px 8px" href="/dashboard/profile/?entity=' + encodeURIComponent(state.entityId) + '#donations">All</a>' +
        '</div>' +
        '<div class="ads-table-wrap" style="margin-top:6px">' + donationsAggTable(data.donations_by_party || []) + '</div>' +
      '</div>' +

      (state.standalone ? evidenceSection(state.entityId) : '')
    );

    var rg = host.querySelector('[data-act="refresh-gov"]');
    if (rg) rg.addEventListener("click", async function () {
      rg.disabled = true; rg.textContent = "Refreshing…";
      try { await api("/api/profile/" + encodeURIComponent(state.entityId) + "/refresh-government", { method: "POST" }); await load(state); }
      catch (e) { rg.textContent = "Failed: " + e.message; rg.disabled = false; }
    });
  }

  function evidenceSection(entityId) {
    return '<div class="ads-card" style="margin-top:14px">' +
      '<div class="ads-active__head"><h3>Evidence quotes</h3><span class="ads-muted" style="font-size:11px">Verbatim quotes backing each classification axis</span></div>' +
      '<div id="ads-profile-evidence"><div class="ads-loading">Loading…</div></div>' +
      '<div data-evidence-entity="' + encodeURIComponent(entityId) + '" hidden></div>' +
    '</div>';
  }

  async function loadEvidence(host, entityId) {
    try {
      var r = await api("/api/profile/" + encodeURIComponent(entityId) + "/evidence?limit=50");
      var items = r.items || [];
      if (!items.length) { host.innerHTML = '<div class="ads-muted" style="font-size:12px">No evidence pinned yet.</div>'; return; }
      host.innerHTML = '<table class="ads-table" style="width:100%;font-size:12px"><thead><tr><th>Axis</th><th>Quote</th><th>Source</th></tr></thead><tbody>' +
        items.map(function (e) {
          return '<tr><td><code style="font-size:10px">' + esc(e.axis) + '</code></td><td>' + esc(e.quote) + '</td><td>' + esc(e.source_kind || "—") + '</td></tr>';
        }).join("") +
      '</tbody></table>';
    } catch (e) { host.innerHTML = '<div class="ads-muted">Evidence unavailable: ' + esc(e.message) + '</div>'; }
  }

  // ---- Header rendering (Task #4) -------------------------------------
  //
  // Pulls display name + subtitle from the tolerant envelope and decides
  // whether to surface the 🪄 auto-correct button. The bad-name predicate
  // is the same module used by the worker — see profile-bad-names.js.
  function findFact(facts, predicate) {
    if (!Array.isArray(facts)) return null;
    for (var i = 0; i < facts.length; i++) {
      if (facts[i] && facts[i].predicate === predicate) return facts[i];
    }
    return null;
  }
  function factValue(f) {
    if (!f) return null;
    if (f.value_text != null && f.value_text !== "") return f.value_text;
    if (f.value_number != null) return f.value_number;
    return null;
  }
  function pickDisplayName(data) {
    var ent = (data && data.entity) || {};
    // Server-suggested fallback first — both sides agree on the predicate.
    if (ent.display_name_is_bad && ent.display_name_fallback) return ent.display_name_fallback;
    var BadName = (window.ADS && window.ADS.BadName) || null;
    if (BadName && BadName.isBadEntityName(ent.display_name)) {
      var derived = BadName.displayFromDomain(ent.primary_url || ent.primary_domain);
      if (derived) return derived;
    }
    return ent.display_name || ent.primary_domain || ent.id || "Profile";
  }
  function buildSubtitle(data) {
    var ent = (data && data.entity) || {};
    var facts = (data && data.facts) || [];
    var parts = [];
    if (ent.kind) parts.push(esc(ent.kind));
    var founded = factValue(findFact(facts, "founded_year"));
    if (founded) parts.push("founded " + esc(String(founded)));
    var city = factValue(findFact(facts, "headquarters_city"));
    var country = factValue(findFact(facts, "headquarters_country"))
                || factValue(findFact(facts, "headquarters_country_iso2"));
    if (city || country) {
      parts.push("HQ " + esc([city, country].filter(Boolean).join(", ")));
    }
    var aum = factValue(findFact(facts, "fund_size_usd"))
           || factValue(findFact(facts, "aum_usd"));
    if (aum != null) {
      var n = Number(aum);
      var aumStr = isFinite(n) ? formatUsd(n) : String(aum);
      parts.push("AUM " + esc(aumStr));
    }
    var website = ent.primary_url || ent.primary_domain;
    if (website) {
      // Protocol allowlist: never let a stored `javascript:` /
      // `data:` URL slip into an operator-clickable href. We coerce
      // bare domains to https:// and drop anything else.
      var raw = String(website);
      var href = null;
      if (/^https?:\/\//i.test(raw)) {
        href = raw;
      } else if (raw.indexOf("://") < 0 && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) {
        href = "https://" + raw;
      }
      if (href) {
        parts.push('<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(website) + '</a>');
      } else {
        parts.push(esc(website));
      }
    }
    return parts.join(" · ");
  }
  function formatUsd(n) {
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return "$" + n;
  }
  function renderStandaloneHeader(state, data) {
    var titleEl = document.getElementById("ads-profile-title");
    var subEl = document.getElementById("ads-profile-subtitle");
    var fillBtn = document.getElementById("ads-profile-fillname");
    if (titleEl) titleEl.textContent = pickDisplayName(data);
    if (subEl) {
      var sub = buildSubtitle(data);
      subEl.innerHTML = sub || '<span class="ads-muted">No metadata yet.</span>';
    }
    if (fillBtn) {
      var ent = (data && data.entity) || {};
      var showFill = !!ent.display_name_is_bad
        || (window.ADS && window.ADS.BadName && window.ADS.BadName.isBadEntityName(ent.display_name));
      fillBtn.style.display = showFill ? "" : "none";
      if (showFill && !fillBtn._wired) {
        fillBtn._wired = true;
        fillBtn.addEventListener("click", async function () {
          fillBtn.disabled = true;
          var prev = fillBtn.textContent;
          fillBtn.textContent = "Filling…";
          try {
            await api("/api/profile/" + encodeURIComponent(state.entityId) + "/fill", { method: "POST" });
            // Bust the 60s envelope cache so the refreshed name appears immediately.
            try { await api("/api/profile/" + encodeURIComponent(state.entityId) + "?bust=1"); } catch (_) { /* ignore */ }
            await load(state);
          } catch (e) {
            fillBtn.textContent = "Failed: " + e.message;
            setTimeout(function () { fillBtn.textContent = prev; fillBtn.disabled = false; }, 3000);
            return;
          }
          fillBtn.textContent = prev;
          fillBtn.disabled = false;
        });
      }
    }
    if (Array.isArray(data && data.missing_subsystems) && data.missing_subsystems.length) {
      console.info("profile: missing subsystems —", data.missing_subsystems.join(", "));
    }
  }

  async function load(state) {
    var pane = state.host;
    var bodyEl = pane.querySelector("[data-profile-body]") || pane;
    try {
      var data = await api("/api/profile/" + encodeURIComponent(state.entityId));
      if (state.standalone) renderStandaloneHeader(state, data);
      renderProfile(bodyEl, data, state);
      if (state.standalone) {
        var ev = pane.querySelector("#ads-profile-evidence");
        if (ev) loadEvidence(ev, state.entityId);
      }
    } catch (e) {
      bodyEl.innerHTML = '<div class="ads-muted">Profile unavailable: ' + esc(e.message) + '</div>';
    }
  }

  async function classify(state, dispatch) {
    var msgEl = state.host.querySelector("[data-profile-msg]") || state.host;
    msgEl.textContent = "Classifying…";
    try {
      var path = "/api/profile/classify/" + encodeURIComponent(state.entityId) + (dispatch ? "/dispatch" : "");
      var r = await api(path, { method: "POST", body: JSON.stringify({ force: true }) });
      msgEl.textContent = dispatch ? ("Workflow queued: " + (r.workflow_id || "ok")) : ("Classified — primary type: " + (r.primary_type || "—"));
      await load(state);
    } catch (e) { msgEl.textContent = "Classify failed: " + e.message; }
  }

  function ensureHeader(host, state) {
    if (host.querySelector("[data-profile-header]")) return;
    var header = document.createElement("div");
    header.setAttribute("data-profile-header", "1");
    header.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px";
    header.innerHTML =
      '<button class="ads-btn" data-act="classify" type="button">Classify now</button>' +
      '<button class="ads-btn" data-act="dispatch" type="button">Queue classify</button>' +
      '<span class="ads-form-msg" data-profile-msg style="margin-left:8px;font-size:12px"></span>';
    host.prepend(header);
    var body = document.createElement("div");
    body.setAttribute("data-profile-body", "1");
    host.appendChild(body);
    header.querySelector('[data-act="classify"]').addEventListener("click", function () { classify(state, false); });
    header.querySelector('[data-act="dispatch"]').addEventListener("click", function () { classify(state, true); });
  }

  async function mount(opts) {
    var host = document.getElementById(opts.rootId);
    if (!host) return;
    var state = { host: host, entityId: opts.entityId, standalone: !!opts.standalone };
    ensureHeader(host, state);
    await load(state);
  }

  async function mountStandalone() {
    var qstate = qs();
    var entityId = await resolveEntityId(qstate);
    var titleEl = document.getElementById("ads-profile-title");
    if (!entityId) {
      if (titleEl) titleEl.textContent = "Profile";
      var host = document.getElementById("ads-profile-root");
      if (host) host.innerHTML = '<div class="ads-muted">No entity selected. Pass <code>?entity=</code> or <code>?table=&ref=</code>.</div>';
      return;
    }
    if (titleEl) titleEl.textContent = "Loading…";
    await mount({ rootId: "ads-profile-root", entityId: entityId, standalone: true });
  }

  window.ADS.Profile = { mount: mount, mountStandalone: mountStandalone, api: api };
})();
