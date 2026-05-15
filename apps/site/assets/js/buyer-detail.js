// Task #58 — Buyer detail page (Overview + Persona fit panel).
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
  function id() { return new URL(window.location.href).searchParams.get("id") || ""; }
  function bar(v) {
    var pct = Math.min(100, Math.max(0, Number(v || 0)));
    return '<span class="ads-bar"><span style="width:' + pct.toFixed(0) + '%"></span></span>' + fmt(v);
  }

  function setStrip(b) {
    var strip = document.getElementById("ads-buyer-strip");
    strip.querySelector('[data-k="fit_score"]').textContent = fmt(b.fit_score);
    strip.querySelector('[data-k="influence_score"]').textContent = fmt(b.influence_score);
    strip.querySelector('[data-k="seniority"]').textContent = b.seniority || "—";
    strip.querySelector('[data-k="is_decision_maker"]').textContent = b.is_decision_maker ? "yes" : "no";
    document.getElementById("ads-buyer-name").textContent = b.name || b.title || b.id;
    document.getElementById("ads-buyer-sub").textContent = [b.title, b.department, b.role_slug].filter(Boolean).join(" · ") || "—";
  }
  function renderOverview(b) {
    var pane = document.querySelector('#ads-buyer-tab-body [data-pane="overview"]');
    var acctLink = b.account_id
      ? '<a href="/dashboard/accounts/detail/?id=' + encodeURIComponent(b.account_id) + '">' + esc(b.account_id) + '</a>'
      : "—";
    pane.innerHTML =
      '<dl style="display:grid;grid-template-columns:160px 1fr;gap:6px 14px;margin:0">' +
      '<dt class="ads-muted">Account</dt><dd>' + acctLink + "</dd>" +
      '<dt class="ads-muted">Title</dt><dd>' + esc(b.title || "—") + "</dd>" +
      '<dt class="ads-muted">Role</dt><dd>' + esc(b.role_slug || "—") + "</dd>" +
      '<dt class="ads-muted">Seniority</dt><dd>' + esc(b.seniority || "—") + "</dd>" +
      '<dt class="ads-muted">Department</dt><dd>' + esc(b.department || "—") + "</dd>" +
      '<dt class="ads-muted">Email</dt><dd>' + esc(b.email || "—") + "</dd>" +
      '<dt class="ads-muted">LinkedIn</dt><dd>' + (b.linkedin_url ? '<a href="' + esc(b.linkedin_url) + '" target="_blank">profile</a>' : "—") + "</dd>" +
      '<dt class="ads-muted">Updated</dt><dd>' + esc(b.updated_at || "—") + "</dd>" +
      "</dl>";
  }

  function renderPersonas(items) {
    var pane = document.querySelector('#ads-buyer-tab-body [data-pane="personas"]');
    if (!pane) return;
    if (!items || !items.length) {
      pane.innerHTML = '<p class="ads-muted">No buyer-kind persona scored this buyer ≥ 50 yet.</p>';
      return;
    }
    pane.innerHTML = '<ul class="ads-persona-fit" style="list-style:none;padding:0;margin:0">' +
      items.map(function (m, i) {
        var pid = "ads-pf-" + i;
        var hasExplain = !!(m.explanation && String(m.explanation).trim());
        return '<li style="border-bottom:1px solid #eef0f5;padding:10px 0">' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<div style="min-width:140px">' + bar(m.fit_score) + '</div>' +
            '<div style="flex:1">' +
              '<a href="/dashboard/personas/edit/?id=' + encodeURIComponent(m.persona_id) + '" style="font-weight:600">' + esc(m.persona_name) + '</a>' +
              ' <span class="ads-chip">' + esc(m.persona_kind) + '</span>' +
              (m.hard_filter_pass ? '' : ' <span class="ads-chip" style="background:#fde2e2;color:#a33" title="One or more hard filters did not pass">hard-filter miss</span>') +
              (m.persona_thesis ? '<div class="ads-muted" style="font-size:12px;margin-top:2px">' + esc(m.persona_thesis) + '</div>' : '') +
            '</div>' +
            (hasExplain
              ? '<button type="button" class="ads-btn ads-btn--ghost" data-toggle="' + pid + '" style="font-size:12px">Why?</button>'
              : '') +
          '</div>' +
          (hasExplain
            ? '<div id="' + pid + '" hidden style="margin:8px 0 0 150px;padding:8px;background:#f7f9fc;border-radius:4px;white-space:pre-wrap;font-size:12px;line-height:1.45">' +
                esc(m.explanation) +
                (m.explanation_at ? '<div class="ads-muted" style="font-size:11px;margin-top:4px">Generated ' + esc(m.explanation_at) + '</div>' : '') +
              '</div>'
            : '') +
        '</li>';
      }).join("") + '</ul>';
    pane.querySelectorAll('button[data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = document.getElementById(btn.getAttribute('data-toggle'));
        if (t) t.hidden = !t.hidden;
      });
    });
  }

  var personasLoaded = false;
  function loadPersonas() {
    var i = id(); if (!i) return;
    api("/api/buyers/" + encodeURIComponent(i) + "/personas").then(function (r) {
      renderPersonas((r && r.items) || []);
    }).catch(function (e) {
      var pane = document.querySelector('#ads-buyer-tab-body [data-pane="personas"]');
      if (pane) pane.innerHTML = '<p class="ads-muted">Failed to load persona fit: ' + esc(e.message) + '</p>';
    });
  }

  function bindTabs() {
    var tabs = document.querySelectorAll("#ads-buyer-tabs .ads-tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        document.querySelectorAll("#ads-buyer-tab-body [data-pane]").forEach(function (p) { p.hidden = true; });
        document.querySelector('#ads-buyer-tab-body [data-pane="' + t.dataset.tab + '"]').hidden = false;
        if (t.dataset.tab === "personas" && !personasLoaded) {
          personasLoaded = true;
          loadPersonas();
        }
      });
    });
  }

  function load() {
    var i = id();
    if (!i) { document.getElementById("ads-buyer-name").textContent = "Missing ?id="; return; }
    api("/api/buyers/" + encodeURIComponent(i)).then(function (d) {
      var b = d.buyer || d;
      setStrip(b);
      renderOverview(b);
    }).catch(function (e) {
      document.getElementById("ads-buyer-name").textContent = "load failed: " + e.message;
    });
  }

  function init() { bindTabs(); load(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
