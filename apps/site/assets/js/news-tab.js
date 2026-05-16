// Task #2: News tab — embeddable on any profile page + standalone page.
//
// Public surface:
//   window.ADS.News.mount({ rootId, entityId })       — embed mode
//   window.ADS.News.mountStandalone()                 — /dashboard/news/
//
// Resolves entity via ?entity=<id> or ?table=…&ref=<id> (mirrors dd-entity.js).

(function () {
  if (window.ADS && window.ADS.News) return;
  window.ADS = window.ADS || {};

  var API = (window.ADS_API_BASE || "https://api.aidatasignal.com").replace(/\/+$/, "");

  function qs() {
    var p = new URLSearchParams(window.location.search);
    return { entity: p.get("entity"), table: p.get("table"), ref: p.get("ref") };
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
      // /api/entities/resolve?table=firms&ref=…  (the same shape DD uses)
      try {
        var r = await api("/api/entities/resolve?table=" + encodeURIComponent(qstate.table) + "&ref=" + encodeURIComponent(qstate.ref));
        return r.entity_id || r.id || null;
      } catch (_) { return null; }
    }
    return null;
  }

  function badgeForRep(score) {
    var tier = score >= 0.9 ? "primary" : score >= 0.8 ? "major" : score >= 0.6 ? "mid" : score >= 0.4 ? "blog" : "low";
    var color = score >= 0.9 ? "#1a7a35" : score >= 0.8 ? "#2c6eb5" : score >= 0.6 ? "#7a5a00" : score >= 0.4 ? "#8a4a00" : "#7a1a1a";
    return '<span style="display:inline-block;padding:1px 6px;border-radius:8px;background:' + color + '20;color:' + color + ';font-size:10px;font-weight:600;text-transform:uppercase">' + tier + " " + score.toFixed(2) + "</span>";
  }

  function sentimentChip(s) {
    if (s === null || s === undefined) return "";
    var label = s > 0.2 ? "positive" : s < -0.2 ? "negative" : "neutral";
    var color = s > 0.2 ? "#1a7a35" : s < -0.2 ? "#a33" : "#666";
    return '<span style="margin-left:6px;font-size:10px;color:' + color + ';font-weight:600">● ' + label + "</span>";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderCard(item) {
    var published = item.published_at || item.fetched_at;
    var date = published ? new Date(published).toLocaleDateString() : "";
    var rep = Number(item.source_reputability || 0);
    var sent = item.sentiment_about_entity != null ? item.sentiment_about_entity : item.sentiment;
    var quote = item.context_quote || item.summary || item.body_excerpt || "";
    return (
      '<div class="ads-card" style="margin-bottom:10px;padding:12px;background:var(--ads-bg-sub,#fafafa)">' +
        '<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ads-muted)">' +
          badgeForRep(rep) +
          '<span style="margin-left:4px">' + esc(item.source_name || item.host) + "</span>" +
          (date ? '<span style="margin-left:8px">' + esc(date) + "</span>" : "") +
          (item.is_subject ? '<span style="margin-left:8px;font-size:10px;color:#1a3a6b;font-weight:600">SUBJECT</span>' : "") +
          sentimentChip(sent) +
        "</div>" +
        '<div style="margin-top:6px;font-size:14px;font-weight:600">' + esc(item.title || item.headline || item.url) + "</div>" +
        (quote ? '<div style="margin-top:6px;font-size:12px;color:var(--ads-text);line-height:1.5">' + esc(String(quote).slice(0, 320)) + "</div>" : "") +
        '<div style="margin-top:8px;display:flex;gap:8px">' +
          '<a class="ads-btn" style="font-size:11px;padding:2px 8px" href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">Read original</a>' +
          (item.archive_url ? '<a class="ads-btn" style="font-size:11px;padding:2px 8px" href="' + esc(item.archive_url) + '" target="_blank" rel="noopener noreferrer">Read archive</a>' : "") +
        "</div>" +
      "</div>"
    );
  }

  async function loadTimeline(state) {
    var p = "/api/news/entity/" + encodeURIComponent(state.entityId) +
            "?limit=100&min_rep=" + encodeURIComponent(state.minRep || 0) +
            (state.topic ? "&topic=" + encodeURIComponent(state.topic) : "") +
            (state.sentiment ? "&sentiment=" + encodeURIComponent(state.sentiment) : "");
    var data = await api(p);
    var items = (data && data.items) || [];
    var html = items.length
      ? items.map(renderCard).join("")
      : '<div class="ads-muted" style="font-size:13px">No news yet. Click <strong>Refresh now</strong> to pull articles.</div>';
    state.host.querySelector(state.sel.timeline).innerHTML = html;
    state.host.querySelector(state.sel.count).textContent = items.length + " article" + (items.length === 1 ? "" : "s");
  }

  async function refresh(state, dispatch) {
    var msg = state.host.querySelector(state.sel.msg);
    msg.textContent = "Refreshing…";
    try {
      var path = "/api/news/refresh/" + encodeURIComponent(state.entityId) + (dispatch ? "/dispatch" : "");
      var r = await api(path, { method: "POST", body: JSON.stringify({ wiki: true, archive: true }) });
      msg.textContent = dispatch
        ? "Workflow queued (" + (r.workflow_id || r.dispatched) + ")."
        : "Persisted " + (r.persisted || 0) + " articles, " + (r.mentions || 0) + " mentions, " + (r.citations || 0) + " citations.";
      await loadTimeline(state);
    } catch (e) {
      msg.textContent = "Refresh failed: " + e.message;
    }
  }

  async function loadCoverage(host) {
    try {
      var data = await api("/api/news/coverage");
      var html = "";
      html += '<h4 style="margin:0 0 4px;font-size:12px">Entities without citations</h4>';
      html += '<div style="font-size:12px;color:var(--ads-muted);margin-bottom:8px">' +
              ((data.entities_without_citations || []).slice(0, 10).map(function (e) {
                return '<a href="/dashboard/news/?entity=' + encodeURIComponent(e.id) + '">' + esc(e.display_name || e.id) + "</a>";
              }).join(" · ") || "—") + "</div>";
      html += '<h4 style="margin:6px 0 4px;font-size:12px">Entities cited only by blogs / tabloids</h4>';
      html += '<div style="font-size:12px;color:var(--ads-muted);margin-bottom:8px">' +
              ((data.entities_only_blog_citations || []).slice(0, 10).map(function (e) {
                return '<a href="/dashboard/news/?entity=' + encodeURIComponent(e.id) + '">' + esc(e.display_name || e.id) + "</a>";
              }).join(" · ") || "—") + "</div>";
      html += '<h4 style="margin:6px 0 4px;font-size:12px">Contradicting facts (top 10)</h4>';
      html += '<ul style="margin:0;padding-left:18px;font-size:12px">' +
              ((data.contradicting_facts || []).slice(0, 10).map(function (f) {
                return '<li>' + esc(f.predicate) + ' (entity ' + esc(f.entity_id) + ') — ' + f.contradicting_citations + ' contradicting</li>';
              }).join("") || '<li>—</li>') + "</ul>";
      host.innerHTML = html;
    } catch (e) {
      host.innerHTML = '<div class="ads-muted">Coverage unavailable: ' + esc(e.message) + "</div>";
    }
  }

  async function mount(opts) {
    var host = document.getElementById(opts.rootId);
    if (!host) return;
    var state = {
      host: host,
      entityId: opts.entityId,
      minRep: opts.minRep || 0.7,
      topic: opts.topic || "",
      sentiment: opts.sentiment || "",
      sel: opts.selectors || {
        timeline: "#ads-news-timeline",
        count: "#ads-news-count",
        msg: "#ads-news-msg",
        coverage: "#ads-news-coverage",
        refreshBtn: "#ads-news-refresh",
        dispatchBtn: "#ads-news-dispatch",
        applyBtn: "#ads-news-apply",
        topicInput: "#ads-news-topic",
        minRepSelect: "#ads-news-min-rep",
        sentSelect: "#ads-news-sent",
      },
    };
    var rBtn = host.querySelector(state.sel.refreshBtn);
    var dBtn = host.querySelector(state.sel.dispatchBtn);
    var aBtn = host.querySelector(state.sel.applyBtn);
    if (rBtn) rBtn.addEventListener("click", function () { refresh(state, false); });
    if (dBtn) dBtn.addEventListener("click", function () { refresh(state, true); });
    if (aBtn) aBtn.addEventListener("click", function () {
      var t = host.querySelector(state.sel.topicInput); if (t) state.topic = t.value.trim();
      var mr = host.querySelector(state.sel.minRepSelect); if (mr) state.minRep = Number(mr.value);
      var ss = host.querySelector(state.sel.sentSelect); if (ss) state.sentiment = ss.value;
      loadTimeline(state);
    });
    await loadTimeline(state);
    var cov = host.querySelector(state.sel.coverage);
    if (cov) loadCoverage(cov);
    var factsHost = host.querySelector("#ads-news-facts");
    if (factsHost) loadVerifiedFacts(factsHost, state.entityId);
  }

  // Task #2: render the entity's facts with `data-fact-id` so
  // citation-pills.js can decorate them with hover/dispute popovers.
  async function loadVerifiedFacts(host, entityId) {
    try {
      var ent = await api("/api/entities/" + encodeURIComponent(entityId));
      var facts = (ent && ent.facts) || [];
      if (!facts.length) { host.innerHTML = '<div class="ads-muted" style="font-size:13px">No facts yet — run a refresh to extract verified claims.</div>'; return; }
      host.innerHTML = '<table class="ads-table" style="width:100%;font-size:13px">' +
        '<thead><tr><th>Predicate</th><th>Value</th><th>Source</th><th>Verified</th></tr></thead><tbody>' +
        facts.map(function (f) {
          var raw = f.value_text != null ? f.value_text : (f.value_number != null ? f.value_number : (f.value != null ? f.value : null));
          var v = raw == null ? "—" : String(raw);
          var verified = f.verified_score == null ? "—" : Number(f.verified_score).toFixed(2);
          return "<tr>" +
            "<td>" + esc(f.predicate || "") + "</td>" +
            '<td><span class="ads-fact" data-fact-id="' + esc(f.id) + '">' + esc(v) + "</span></td>" +
            "<td>" + esc(f.source_kind || "") + "</td>" +
            "<td>" + verified + "</td>" +
          "</tr>";
        }).join("") +
        "</tbody></table>";
      // Re-trigger citation-pill decoration after innerHTML swap.
      if (window.ADS && window.ADS.CitationPills && window.ADS.CitationPills.decorate) {
        window.ADS.CitationPills.decorate(host);
      }
    } catch (e) {
      host.innerHTML = '<div class="ads-muted">Facts unavailable: ' + esc(e.message) + "</div>";
    }
  }

  async function mountStandalone() {
    var qstate = qs();
    var entityId = await resolveEntityId(qstate);
    var titleEl = document.getElementById("ads-news-title");
    if (!entityId) {
      var t = document.getElementById("ads-news-msg");
      if (t) t.textContent = "No entity id resolved. Pass ?entity= or ?table=&ref=.";
      var timeline = document.getElementById("ads-news-timeline");
      if (timeline) timeline.innerHTML = '<div class="ads-muted" style="font-size:13px">No entity selected.</div>';
      return;
    }
    if (titleEl) titleEl.textContent = "News — entity " + entityId;
    // The whole page IS the widget — mount against <body> so the standard
    // mount() selectors (#ads-news-timeline etc.) resolve correctly.
    await mount({ rootId: document.body.id || (document.body.id = "ads-news-body"), entityId: entityId, minRep: 0.7 });
  }

  window.ADS.News = { mount: mount, mountStandalone: mountStandalone, api: api };
})();
