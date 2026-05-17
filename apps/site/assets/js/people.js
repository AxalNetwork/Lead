// Task #6: dossier UI for /dashboard/people/?id=<entity_id>
// (also reached via /dashboard/people/<id> and /dashboard/profiles/<id>
// thanks to the 404.html SPA redirect).
//
// Consumes:
//   GET    /api/profilers/:id/dossier
//   POST   /api/profilers/:id/run
//   POST   /api/profilers/:id/audit
//   GET    /api/profilers/:id/changelog
//   GET    /api/profilers/:id/sources
//   GET    /api/profile-comments/:id
//   POST   /api/profile-comments/:id
//   DELETE /api/profile-comments/:id/:comment_id

(function () {
  // ---- helpers --------------------------------------------------------
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function qsId() {
    var p = new URLSearchParams(location.search);
    var fromPath = (location.pathname.match(/\/(?:people|profiles)\/([^/?#]+)\/?$/) || [])[1];
    return p.get("id") || fromPath || "";
  }
  async function api(path, init) {
    try { return await window.adsApiFetch(path, init); } catch (e) { console.warn(path, e); return null; }
  }
  function fmtDate(s) {
    if (!s) return "";
    try { return new Date(s).toLocaleString(); } catch (e) { return String(s); }
  }
  function fmtDay(s) {
    if (!s) return "";
    try { return new Date(s).toLocaleDateString(); } catch (e) { return String(s); }
  }
  function relTime(s) {
    if (!s) return "";
    var t = Date.parse(s); if (isNaN(t)) return s;
    var d = (Date.now() - t) / 1000;
    if (d < 60) return Math.floor(d) + "s ago";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    if (d < 7 * 86400) return Math.floor(d / 86400) + "d ago";
    return fmtDay(s);
  }
  function setMsg(text, kind) {
    var el = document.getElementById("ads-person-msg");
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.className = "ads-person-header__msg" + (kind ? " ads-person-header__msg--" + kind : "");
    el.textContent = text;
  }
  function emptyCard(text) {
    return '<div class="ads-empty">' + esc(text) + "</div>";
  }

  // ---- predicate label resolver --------------------------------------
  var PRED_LABELS = {
    "person.identity.full_name": "Full name",
    "person.identity.preferred_name": "Preferred name",
    "person.identity.pronouns": "Pronouns",
    "person.identity.birth_year": "Birth year",
    "person.identity.nationality": "Nationality",
    "person.identity.languages": "Languages",
    "person.identity.timezone": "Timezone",
    "person.identity.location_city": "City",
    "person.identity.location_country": "Country",
    "person.identity.headshot_url": "Headshot",
    "person.career": "Career",
    "person.board_seat": "Board seat",
    "person.education": "Education",
    "person.family_tie": "Family tie",
    "person.conference": "Conference",
  };
  function predicateLabel(p) {
    if (!p) return "";
    if (PRED_LABELS[p]) return PRED_LABELS[p];
    var seg = String(p).split(".").pop().replace(/_/g, " ");
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  }

  // ---- Fact wrapper ---------------------------------------------------
  // Spec: facts without a source_url MUST NOT render, EXCEPT operator-
  // asserted identity fields, which render with an explicit
  // "operator-asserted" badge. Confidence is rendered as a single
  // color-graded chip (red < 0.4, amber < 0.7, green ≥ 0.7) rather
  // than a row of monochrome dots.
  function isOperatorAsserted(opts) {
    var k = String(opts.source_kind || opts.source || "").toLowerCase();
    return k === "operator_asserted" || k === "operator" || k === "manual";
  }
  function confLevel(c) {
    var v = (c == null ? 1 : Number(c)) || 0;
    if (v < 0.4) return "low";
    if (v < 0.7) return "mid";
    return "hi";
  }
  function confChip(c) {
    var lvl = confLevel(c);
    var pct = Math.round(Math.max(0, Math.min(1, (c == null ? 1 : Number(c)) || 0)) * 100);
    var lbl = { low: "low confidence", mid: "medium confidence", hi: "high confidence" }[lvl];
    return '<span class="ads-conf ads-conf--' + lvl + '" title="' + lbl + '" aria-label="' + lbl + ' (' + pct + '%)">' + pct + '%</span>';
  }
  // Returns "" when the fact has no source URL AND isn't operator-asserted.
  // Returns inline HTML otherwise.
  function fact(value, opts) {
    opts = opts || {};
    if (value == null || value === "") return "";
    var url = opts.evidence_url || opts.source_url || "";
    var op = isOperatorAsserted(opts);
    if (!url && !op) return ""; // contract: hide unsourced facts
    var src = opts.source || opts.source_kind || "";
    var title = src ? src + (url ? "\n" + url : "") : (url || "");
    var inner = '<span class="ads-fact__value">' + esc(value) + "</span>";
    if (url) {
      inner = '<a class="ads-fact__link" href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(title) + '">' + inner + "</a>";
    } else if (title) {
      inner = '<span title="' + esc(title) + '">' + inner + "</span>";
    }
    var opBadge = op ? ' <span class="ads-badge ads-badge--op" title="Asserted by operator, not a public source">operator-asserted</span>' : "";
    return '<span class="ads-fact">' + inner + " " + confChip(opts.confidence) + opBadge + "</span>";
  }
  // Like fact() but used in tables/lists where the cell should always
  // render *something*. When the underlying fact is unsourced and
  // non-operator, we render an em-dash rather than the raw value so
  // operators never see uncited claims.
  function factOrDash(value, opts) {
    var f = fact(value, opts);
    return f || '<span class="ads-muted">—</span>';
  }

  // ---- 25-word summary derivation ------------------------------------
  function deriveSummary(dossier) {
    var synth = dossier && dossier.latest_synthesis;
    var tdb = synth && synth.to_do_business_with_them;
    if (tdb && typeof tdb === "object") {
      var candidates = [tdb.executive_summary, tdb.summary, tdb.tldr, tdb.opener_brief, tdb.why_relevant];
      for (var i = 0; i < candidates.length; i++) {
        if (typeof candidates[i] === "string" && candidates[i].trim()) {
          return truncateWords(candidates[i].trim(), 25);
        }
      }
    }
    var id = dossier && dossier.identity;
    if (id) {
      var bits = [];
      if (id.full_name) bits.push(id.full_name);
      if (id.location_city || id.location_country) bits.push("based in " + [id.location_city, id.location_country].filter(Boolean).join(", "));
      if (bits.length) return truncateWords(bits.join(", "), 25);
    }
    return "Run profiler to generate dossier.";
  }
  function truncateWords(s, n) {
    var w = String(s).split(/\s+/);
    if (w.length <= n) return s;
    return w.slice(0, n).join(" ") + "…";
  }

  // ---- trust rings (3 SVGs) ------------------------------------------
  function ring(label, pct, color) {
    var R = 22, C = 2 * Math.PI * R;
    var p = Math.max(0, Math.min(1, pct));
    var off = C * (1 - p);
    return '<div class="ads-ring">' +
      '<svg viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">' +
      '<circle cx="28" cy="28" r="' + R + '" stroke="var(--ads-border)" stroke-width="6" fill="none"/>' +
      '<circle cx="28" cy="28" r="' + R + '" stroke="' + color + '" stroke-width="6" fill="none" ' +
        'stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '" ' +
        'transform="rotate(-90 28 28)" stroke-linecap="round"/>' +
      '<text x="28" y="33" text-anchor="middle" font-size="14" fill="var(--ads-text)" font-weight="700">' + Math.round(p * 100) + '</text>' +
      '</svg>' +
      '<span class="ads-ring__label">' + esc(label) + '</span>' +
      '</div>';
  }
  function renderRings(d) {
    var TOTAL = 13;
    var completeness = (d.populated_tables || []).length / TOTAL;
    var skipped = (d.privacy_skipped_enrichers || []).length;
    var authenticity = Math.max(0.3, Math.min(1, 1 - skipped / 30));
    var confBase = d.latest_synthesis ? 0.6 : 0.2;
    var cites = d.latest_synthesis ? (d.latest_synthesis.citations_count || 0) : 0;
    var confidence = Math.min(1, confBase + Math.min(0.4, cites / 25));
    document.getElementById("ads-person-rings").innerHTML =
      ring("Completeness", completeness, "var(--ads-accent)") +
      ring("Confidence",   confidence,   "var(--ads-accent-2)") +
      ring("Authenticity", authenticity, "var(--ads-warn)");
  }

  // ---- timezone live clock -------------------------------------------
  var tzTimer = null;
  function startTimezoneClock(tz) {
    var el = document.getElementById("ads-person-tz");
    if (!el) return;
    if (tzTimer) { clearInterval(tzTimer); tzTimer = null; }
    if (!tz) { el.hidden = true; return; }
    function tick() {
      try {
        var now = new Date();
        var t = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: tz });
        el.textContent = "🕒 " + t + " local (" + tz + ")";
        el.hidden = false;
      } catch (e) {
        el.textContent = "🕒 " + tz;
        el.hidden = false;
      }
    }
    tick();
    tzTimer = setInterval(tick, 30000);
  }

  // ---- pane renderers -------------------------------------------------
  function paneOverview(d) {
    var id = d.identity || {};
    var rows = [];
    function row(label, val, opts) {
      var html = fact(val, opts || {});
      if (!html) return; // hide unsourced rows entirely
      rows.push('<tr><th>' + esc(label) + '</th><td>' + html + '</td></tr>');
    }
    row("Full name", id.full_name, { source_kind: id.source_kind || id.source || "operator_asserted", evidence_url: id.source_url, confidence: id.confidence });
    row("Preferred name", id.preferred_name, { source_kind: id.preferred_name_source_kind, source_url: id.preferred_name_source_url, confidence: id.preferred_name_confidence });
    row("Pronouns", id.pronouns, { source_kind: id.pronouns_source_kind, source_url: id.pronouns_source_url, confidence: id.pronouns_confidence });
    row("Birth year", id.birth_year, { source_kind: id.birth_year_source_kind, source_url: id.birth_year_source_url, confidence: id.birth_year_confidence });
    row("Nationality", id.nationality, { source_kind: id.nationality_source_kind, source_url: id.nationality_source_url, confidence: id.nationality_confidence });
    row("Timezone", id.timezone, { source_kind: id.timezone_source_kind || "operator_asserted", source_url: id.timezone_source_url, confidence: id.timezone_confidence });
    row("City", id.location_city, { source_kind: id.location_source_kind, source_url: id.location_source_url, confidence: id.location_confidence });
    row("Country", id.location_country, { source_kind: id.location_source_kind, source_url: id.location_source_url, confidence: id.location_confidence });
    var langs = id.languages_json ? safeJson(id.languages_json) : null;
    if (Array.isArray(langs) && langs.length) {
      row("Languages", langs.map(function (l) { return typeof l === "string" ? l : (l.name || l.code); }).join(", "),
          { source_kind: "operator_asserted", confidence: 0.8 });
    }
    var html = "";
    if (id.headshot_url) {
      html += '<div style="float:right;margin:0 0 12px 16px"><img src="' + esc(id.headshot_url) + '" alt="" style="width:120px;height:120px;border-radius:12px;object-fit:cover;border:1px solid var(--ads-border)"></div>';
    }
    html += rows.length
      ? '<table class="ads-table ads-table--kv">' + rows.join("") + '</table>'
      : emptyCard("No sourced identity fields yet.");
    var skipped = d.privacy_skipped_enrichers || [];
    if (skipped.length) {
      html += '<div style="margin-top:18px"><h3 style="margin-bottom:8px">Skipped for privacy</h3><div class="ads-tag-row">' +
        skipped.map(function (s) {
          return '<span class="ads-pill idle" title="' + esc(s.reason) + '">' + esc(s.enricher_name) + '</span>';
        }).join(" ") + '</div></div>';
    }
    var pop = d.populated_tables || [];
    if (pop.length) {
      html += '<div style="margin-top:18px"><h3 style="margin-bottom:8px">Populated tables (' + pop.length + ')</h3><div class="ads-tag-row">' +
        pop.map(function (t) { return '<span class="ads-pill ok">' + esc(t) + '</span>'; }).join(" ") + '</div></div>';
    }
    document.getElementById("ads-pane-overview").innerHTML = html;
  }
  function safeJson(s) {
    if (s == null) return null;
    if (typeof s === "object") return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function paneCareer(d) {
    var c = d.career_history || [];
    var b = d.board_seats || [];
    var html = "";
    html += '<h3>Career history (' + c.length + ')</h3>';
    if (!c.length) html += emptyCard("No career entries.");
    else {
      html += '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Title</th><th>Organization</th><th>From</th><th>To</th><th>Source</th></tr></thead><tbody>';
      c.forEach(function (r) {
        html += "<tr><td>" + esc(r.title || "—") + "</td>" +
                "<td>" + esc(r.organization_name || r.organization || "—") + "</td>" +
                "<td>" + esc(r.started_at || "") + "</td>" +
                "<td>" + esc(r.is_current ? "current" : (r.ended_at || "")) + "</td>" +
                "<td>" + factOrDash(r.source || "source", { evidence_url: r.source_url, source_kind: r.source_kind, confidence: r.confidence }) + "</td></tr>";
      });
      html += "</tbody></table></div>";
    }
    html += '<h3 style="margin-top:24px">Board seats (' + b.length + ')</h3>';
    if (!b.length) html += emptyCard("No board seats.");
    else {
      html += '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Organization</th><th>Role</th><th>From</th><th>To</th></tr></thead><tbody>';
      b.forEach(function (r) {
        html += "<tr><td>" + esc(r.organization_name || r.organization || "—") + "</td>" +
                "<td>" + esc(r.role || "Board member") + "</td>" +
                "<td>" + esc(r.started_at || "") + "</td>" +
                "<td>" + esc(r.ended_at || "current") + "</td></tr>";
      });
      html += "</tbody></table></div>";
    }
    document.getElementById("ads-pane-career").innerHTML = html;
  }

  function paneBackground(d) {
    var e = d.education_history || [];
    var f = d.family_ties_public || [];
    var html = "";
    html += '<h3>Education (' + e.length + ')</h3>';
    if (!e.length) html += emptyCard("No education entries.");
    else {
      html += '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Institution</th><th>Degree</th><th>Field</th><th>Years</th></tr></thead><tbody>';
      e.forEach(function (r) {
        var years = [r.started_year || r.started_at, r.ended_year || r.ended_at].filter(Boolean).join("–");
        html += "<tr><td>" + esc(r.institution || "—") + "</td>" +
                "<td>" + esc(r.degree || "") + "</td>" +
                "<td>" + esc(r.field || "") + "</td>" +
                "<td>" + esc(years) + "</td></tr>";
      });
      html += "</tbody></table></div>";
    }
    html += '<h3 style="margin-top:24px">Public family ties (' + f.length + ')</h3>';
    if (!f.length) html += '<p class="ads-muted" style="margin:0">No public family ties on file. Private ties never surface here.</p>';
    else {
      html += '<ul style="margin:0;padding-left:18px">' + f.map(function (r) {
        return "<li>" + esc(r.relation || "relative") + ": " + esc(r.related_name || "—") +
          (r.source ? " <span class='ads-muted' style='font-size:11px'>(" + esc(r.source) + ")</span>" : "") + "</li>";
      }).join("") + '</ul>';
    }
    document.getElementById("ads-pane-background").innerHTML = html;
  }

  function paneInterests(d) {
    var pref = d.preferences || [];
    var ints = d.interests || [];
    var life = d.lifestyle_signals || [];
    var travel = d.travel_patterns || [];
    var conf = d.conference_attendance || [];
    var html = "";

    html += '<h3>Preferences (' + pref.length + ')</h3>';
    if (!pref.length) html += emptyCard("None collected.");
    else {
      html += '<div class="ads-tag-row">' + pref.map(function (p) {
        var label = predicateLabel("person.preference." + (p.preference_key || p.key || ""));
        var val = p.value_text || p.value || "—";
        return '<span class="ads-pill ok">' + esc(label) + ': ' + esc(val) + '</span>';
      }).join(" ") + '</div>';
    }

    html += '<h3 style="margin-top:20px">Interests (' + ints.length + ')</h3>';
    if (!ints.length) html += emptyCard("None collected.");
    else {
      html += '<div class="ads-tag-row">' + ints.map(function (i) {
        return '<span class="ads-pill ok">' + esc(i.category || "topic") + ': ' + esc(i.label || i.value || "—") + '</span>';
      }).join(" ") + '</div>';
    }

    html += '<h3 style="margin-top:20px">Lifestyle signals (' + life.length + ')</h3>';
    if (!life.length) html += emptyCard("None collected.");
    else {
      html += '<ul style="margin:0;padding-left:18px">' + life.map(function (s) {
        return "<li>" + esc(s.signal_kind || "signal") + ": " + esc(s.value_text || s.value || "—") +
          " <span class='ads-muted' style='font-size:11px'>" + esc(s.source || "") + "</span></li>";
      }).join("") + "</ul>";
    }

    html += '<h3 style="margin-top:20px">Travel patterns (' + travel.length + ')</h3>';
    if (!travel.length) html += emptyCard("None collected.");
    else {
      html += '<ul style="margin:0;padding-left:18px">' + travel.map(function (t) {
        return "<li>" + esc(t.pattern_kind || "pattern") + ": " + esc(t.value_text || t.value || "—") + "</li>";
      }).join("") + "</ul>";
    }

    html += '<h3 style="margin-top:20px">Conferences (' + conf.length + ')</h3>';
    if (!conf.length) html += emptyCard("None collected.");
    else {
      html += '<ul style="margin:0;padding-left:18px">' + conf.map(function (c) {
        return "<li>" + esc(c.conference_name || "—") + " " + esc(c.year || "") +
          (c.role ? " <span class='ads-muted' style='font-size:11px'>(" + esc(c.role) + ")</span>" : "") + "</li>";
      }).join("") + "</ul>";
    }
    document.getElementById("ads-pane-interests").innerHTML = html;
  }

  function paneNetwork(d) {
    var synth = d.latest_synthesis && d.latest_synthesis.to_do_business_with_them;
    var paths = (synth && (synth.warm_intro_paths || synth.warmIntroPaths)) || [];
    var html = "";
    html += '<h3>Warm intro paths (' + paths.length + ')</h3>';
    if (!paths.length) {
      html += '<p class="ads-muted" style="margin:0">No two-hop intro paths from your viewer entity.</p>';
    } else {
      html += '<ol style="margin:0;padding-left:18px">' + paths.map(function (p) {
        var via = Array.isArray(p.via) ? p.via.join(" → ") : (p.via || "");
        var weight = p.weight != null ? " <span class='ads-muted' style='font-size:11px'>(weight " + esc(p.weight) + ")</span>" : "";
        return "<li>" + esc(p.target_name || p.target || p.to || "—") +
          (via ? " <span class='ads-muted'>via " + esc(via) + "</span>" : "") + weight + "</li>";
      }).join("") + "</ol>";
    }
    html += '<div style="margin-top:14px"><a class="ads-btn ads-btn--ghost ads-btn--sm" href="/dashboard/lead/?id=' +
      encodeURIComponent(d.entity_id) + '">Open full relationship graph</a></div>';
    document.getElementById("ads-pane-network").innerHTML = html;
  }

  function paneVoice(d) {
    var hooks = d.conversation_hooks || [];
    var apprec = d.appreciation_signals || [];
    var html = "";
    html += '<h3>Conversation hooks (' + hooks.length + ')</h3>';
    if (!hooks.length) html += emptyCard("No hooks yet.");
    else {
      html += '<ul style="margin:0;padding-left:18px">' + hooks.map(function (h) {
        return "<li>" + esc(h.hook_text || h.value || "—") +
          " <span class='ads-muted' style='font-size:11px'>" + esc(h.source || "") + "</span></li>";
      }).join("") + "</ul>";
    }
    html += '<h3 style="margin-top:20px">Appreciation signals (' + apprec.length + ')</h3>';
    if (!apprec.length) html += emptyCard("None collected.");
    else {
      html += '<ul style="margin:0;padding-left:18px">' + apprec.map(function (a) {
        return "<li>" + esc(a.appreciation_kind || "kind") + ": " + esc(a.value_text || a.value || "—") + "</li>";
      }).join("") + "</ul>";
    }
    document.getElementById("ads-pane-voice").innerHTML = html;
  }

  function renderListSection(label, items, mapper) {
    if (!items || !items.length) return "";
    return '<div style="margin-bottom:14px"><h3 style="margin-bottom:6px">' + esc(label) + '</h3>' +
      '<ul style="margin:0;padding-left:18px">' + items.map(mapper).join("") + '</ul></div>';
  }
  function paneOutreach(d) {
    var synth = d.latest_synthesis;
    var tdb = synth && synth.to_do_business_with_them;
    var html = "";
    if (!synth) {
      html += '<p class="ads-muted" style="margin:0 0 14px">No synthesis on record. Click <b>Refresh</b> to generate one.</p>';
    } else {
      html += '<div class="ads-muted" style="font-size:12px;margin-bottom:14px">Synthesized ' + esc(relTime(synth.computed_at)) +
        ' · model <code>' + esc(synth.llm_model || "n/a") + '</code> · ' +
        esc(synth.citations_count || 0) + ' citations · ' +
        esc(synth.conversation_starters_count || 0) + ' starters</div>';
    }
    if (tdb && typeof tdb === "object") {
      var sections = [
        ["Executive summary", tdb.executive_summary || tdb.summary],
        ["Why I should know them", tdb.why_relevant || tdb.why],
        ["Conversation starters", tdb.conversation_starters],
        ["Gift ideas", tdb.gift_ideas],
        ["Best contact channel", tdb.best_channel || tdb.best_contact_channel],
        ["Risks / topics to avoid", tdb.risks || tdb.topics_to_avoid],
      ];
      sections.forEach(function (pair) {
        var label = pair[0], val = pair[1];
        if (val == null || (typeof val === "string" && !val.trim())) return;
        if (typeof val === "string") {
          html += '<div style="margin-bottom:14px"><h3 style="margin-bottom:6px">' + esc(label) + '</h3>' +
            '<p style="margin:0;white-space:pre-wrap">' + esc(val) + '</p></div>';
        } else if (Array.isArray(val)) {
          html += renderListSection(label, val, function (v) {
            // Spec: never leak raw JSON to operators. Objects render as
            // a single string field, never the whole blob.
            if (typeof v === "string") return "<li>" + esc(v) + "</li>";
            var pick = (v && (v.text || v.title || v.label || v.value || v.summary)) || "";
            return pick ? "<li>" + esc(pick) + "</li>" : "";
          });
        }
        // Object-valued sections that aren't strings/arrays are skipped
        // entirely — operators get nothing rather than raw JSON.
      });
    }
    if (!html) html += emptyCard("Nothing to render.");
    document.getElementById("ads-pane-outreach").innerHTML = html;
  }

  // Intelligence tab: sensitive subsection is collapsed by default and
  // POSTs an audit log entry the first time it's expanded. Surfaces
  // pHash duplicate signals, privacy reasons, and per-enricher coverage.
  function paneIntelligence(d, entityId) {
    var html = "";
    html += '<h3>Coverage</h3>';
    var pop = d.populated_tables || [];
    var TOTAL = 13;
    html += '<p class="ads-muted" style="margin:0 0 8px">' + esc(pop.length) + ' of ' + TOTAL + ' tables populated.</p>';
    html += '<div class="ads-tag-row">' + pop.map(function (t) { return '<span class="ads-pill ok">' + esc(t) + '</span>'; }).join(" ") + '</div>';

    var skipped = d.privacy_skipped_enrichers || [];
    html += '<h3 style="margin-top:18px">Privacy decisions (' + skipped.length + ')</h3>';
    if (!skipped.length) html += emptyCard("Nothing was skipped for privacy on the last run.");
    else {
      html += '<ul style="margin:0;padding-left:18px">' + skipped.map(function (s) {
        return "<li><b>" + esc(s.enricher_name) + "</b> — " + esc(s.reason || "no reason given") + "</li>";
      }).join("") + "</ul>";
    }

    // pHash / duplicate signal block (only shows when a candidate is reported).
    var phash = d.phash_duplicate || (d.identity && d.identity.phash_duplicate);
    if (phash) {
      html += '<h3 style="margin-top:18px">Possible duplicate</h3>' +
        '<p style="margin:0">Avatar pHash matches entity <code>' + esc(phash.entity_id || "?") + '</code>' +
        (phash.distance != null ? ' (Hamming ' + esc(phash.distance) + ')' : '') + '. ' +
        '<a href="/dashboard/people/?id=' + esc(phash.entity_id) + '">Open the other dossier</a>.</p>';
    }

    // Collapsed sensitive subsection — audit-logged on first open.
    html += '<details class="ads-sensitive" id="ads-sensitive"><summary>Sensitive sources &amp; raw signals</summary>' +
      '<div class="ads-sensitive__body">' +
        '<p class="ads-muted" style="margin:0 0 8px;font-size:12px">Opening this section is recorded in <code>pii_audit_log</code>.</p>' +
        '<div id="ads-sensitive-content"><div class="ads-skeleton ads-skeleton--sm"></div></div>' +
      '</div></details>';

    document.getElementById("ads-pane-intelligence").innerHTML = html;

    var details = document.getElementById("ads-sensitive");
    var loaded = false;
    if (details) {
      details.addEventListener("toggle", async function () {
        if (!details.open || loaded) return;
        loaded = true;
        await api("/api/profilers/" + encodeURIComponent(entityId) + "/audit",
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dossier_sensitive_open" }) });
        var inner = document.getElementById("ads-sensitive-content");
        var hits = (d.osint_resolved || []).concat(d.identity_handles || []);
        if (!hits.length) {
          inner.innerHTML = emptyCard("No OSINT pivots resolved yet.");
          return;
        }
        inner.innerHTML = '<ul style="margin:0;padding-left:18px">' + hits.slice(0, 50).map(function (h) {
          return "<li><b>" + esc(h.platform || h.kind || "signal") + "</b>: " +
            esc(h.handle || h.value || "—") +
            (h.confidence != null ? " " + confChip(h.confidence) : "") + "</li>";
        }).join("") + "</ul>";
      });
    }
  }

  // ---- right rail -----------------------------------------------------
  async function loadSources(id) {
    var r = await api("/api/profilers/" + encodeURIComponent(id) + "/sources");
    var el = document.getElementById("ads-person-sources");
    var items = (r && r.items) || [];
    if (!items.length) { el.innerHTML = emptyCard("No sources yet."); return; }
    el.innerHTML = '<ul class="ads-mini-list">' + items.slice(0, 10).map(function (s) {
      return "<li><span class='ads-pill idle'>" + esc(s.source_kind) + "</span> " +
        esc(s.source) + " <span class='ads-muted' style='font-size:11px'>×" + s.n + "</span></li>";
    }).join("") + "</ul>";
  }
  async function loadChangelog(id) {
    var r = await api("/api/profilers/" + encodeURIComponent(id) + "/changelog?limit=10");
    var el = document.getElementById("ads-person-changelog");
    var items = (r && r.items) || [];
    if (!items.length) { el.innerHTML = emptyCard("No edits yet."); return; }
    el.innerHTML = '<ul class="ads-mini-list">' + items.map(function (f) {
      var v = f.value_text != null ? f.value_text : (f.value_number != null ? f.value_number : "");
      return "<li><b>" + esc(predicateLabel(f.predicate)) + "</b> " +
        '<span class="ads-muted" style="font-size:11px">' + esc(relTime(f.observed_at)) + "</span><br>" +
        '<span style="font-size:12px">' + factOrDash(v, { source: f.source, source_kind: f.source_kind, evidence_url: f.evidence_url, confidence: f.confidence }) + "</span></li>";
    }).join("") + "</ul>";
  }
  async function loadComments(id) {
    var r = await api("/api/profile-comments/" + encodeURIComponent(id));
    var el = document.getElementById("ads-person-comments");
    var items = (r && r.items) || [];
    if (!items.length) { el.innerHTML = emptyCard("No comments yet."); return; }
    el.innerHTML = items.map(function (c) {
      return '<div class="ads-comment">' +
        '<div class="ads-comment__head">' +
          '<span>' + esc(c.author_email) + '</span>' +
          '<span class="ads-muted" style="font-size:11px">' + esc(relTime(c.created_at)) + "</span>" +
          ' <button type="button" class="ads-comment__del" data-id="' + esc(c.id) + '" aria-label="Delete">×</button>' +
        '</div>' +
        '<div class="ads-comment__body">' + esc(c.body) + "</div>" +
        '</div>';
    }).join("");
    el.querySelectorAll(".ads-comment__del").forEach(function (b) {
      b.addEventListener("click", async function () {
        if (!confirm("Delete this comment?")) return;
        var cid = b.getAttribute("data-id");
        await api("/api/profile-comments/" + encodeURIComponent(id) + "/" + encodeURIComponent(cid), { method: "DELETE" });
        loadComments(id);
      });
    });
  }

  // ---- tabs (lazy-loaded) --------------------------------------------
  // Each pane is rendered exactly once, on first activation, behind a
  // skeleton. The Overview pane renders immediately so the page paints
  // useful content above the fold without waiting on tab interaction.
  var paneRenderers = null;
  var paneRendered = {};
  function activate(name) {
    document.querySelectorAll(".ads-person-tabs .ads-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".ads-tab-panel").forEach(function (p) {
      var on = p.getAttribute("data-tab") === name;
      p.classList.toggle("active", on);
      p.hidden = !on;
    });
    if (paneRenderers && paneRenderers[name] && !paneRendered[name]) {
      try { paneRenderers[name](); paneRendered[name] = true; }
      catch (e) { console.warn("pane " + name + " render failed", e); }
    }
    try { history.replaceState(null, "", "#" + name); } catch (e) { /* noop */ }
  }

  // ---- header quick actions ------------------------------------------
  function pickPrimaryRole(d) {
    var c = (d.career_history || []).slice();
    c.sort(function (a, b) {
      var ac = a.is_current ? 1 : 0, bc = b.is_current ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return (b.started_at || "").localeCompare(a.started_at || "");
    });
    return c[0] || null;
  }
  function findLinkedIn(d) {
    var handles = d.identity_handles || [];
    for (var i = 0; i < handles.length; i++) {
      var h = handles[i];
      if (String(h.platform || "").toLowerCase() === "linkedin") {
        return h.url || ("https://www.linkedin.com/in/" + h.handle);
      }
    }
    return null;
  }
  function renderHeader(d) {
    var id_ = d.identity || {};
    var display = id_.full_name || id_.preferred_name || ("Entity " + (d.entity_id || "").slice(0, 8));
    document.getElementById("ads-person-name").textContent = display;

    var pron = document.getElementById("ads-person-pronouns");
    if (id_.pronouns) { pron.textContent = "(" + id_.pronouns + ")"; pron.hidden = false; }

    var phash = d.phash_duplicate || id_.phash_duplicate;
    if (phash) document.getElementById("ads-person-phash").hidden = false;

    var role = pickPrimaryRole(d);
    var roleEl = document.getElementById("ads-person-role");
    if (role) {
      var org = role.organization_name || role.organization || "";
      var label = (role.title || "") + (role.title && org ? " at " : "") + org;
      if (role.organization_entity_id) {
        roleEl.innerHTML = esc(role.title || "") + (role.title && org ? " at " : "") +
          '<a href="/dashboard/company-detail/?id=' + esc(role.organization_entity_id) + '">' + esc(org) + '</a>';
      } else {
        roleEl.textContent = label;
      }
    } else {
      var subBits = [id_.headline, id_.location_city, id_.location_country].filter(Boolean);
      roleEl.textContent = subBits.join(" · ") || "—";
    }

    document.getElementById("ads-person-summary").textContent = deriveSummary(d);
    var avatar = document.getElementById("ads-person-avatar");
    if (id_.headshot_url) {
      avatar.innerHTML = '<img src="' + esc(id_.headshot_url) + '" alt="">';
      avatar.classList.add("has-img");
    } else {
      avatar.textContent = (display || "?").trim().charAt(0).toUpperCase();
    }
    renderRings(d);
    startTimezoneClock(id_.timezone);

    // Quick actions.
    var primaryEmail = id_.primary_email || id_.email;
    if (primaryEmail) {
      var eb = document.getElementById("ads-qa-email");
      eb.href = "mailto:" + primaryEmail;
      eb.hidden = false;
      var cb = document.getElementById("ads-qa-calendar");
      cb.href = "https://calendar.google.com/calendar/u/0/r/eventedit?add=" + encodeURIComponent(primaryEmail) +
        "&text=" + encodeURIComponent("Meeting with " + display);
      cb.hidden = false;
    }
    var li = findLinkedIn(d);
    if (li) {
      var lb = document.getElementById("ads-qa-linkedin");
      lb.href = li;
      lb.hidden = false;
    }
    var handles = d.identity_handles || [];
    if (handles.length) {
      var hb = document.getElementById("ads-qa-copy-handle");
      hb.hidden = false;
      hb.addEventListener("click", function () {
        try {
          var first = handles[0];
          navigator.clipboard.writeText(String(first.handle || first.url || ""));
          setMsg("Handle copied.", "ok");
        } catch (e) { setMsg("Copy failed.", "err"); }
      });
    }
  }

  // ---- top-level load -------------------------------------------------
  async function loadDossier(id) {
    var d = await api("/api/profilers/" + encodeURIComponent(id) + "/dossier");
    if (!d || d.error) {
      document.getElementById("ads-person-name").textContent = "Not found";
      document.getElementById("ads-person-role").textContent = id;
      document.getElementById("ads-pane-overview").innerHTML = emptyCard((d && d.error) || "Could not load dossier.");
      return;
    }
    renderHeader(d);

    // Bind lazy pane renderers — only Overview runs now.
    paneRenderers = {
      overview:     function () { paneOverview(d); },
      career:       function () { paneCareer(d); },
      background:   function () { paneBackground(d); },
      interests:    function () { paneInterests(d); },
      network:      function () { paneNetwork(d); },
      voice:        function () { paneVoice(d); },
      outreach:     function () { paneOutreach(d); },
      intelligence: function () { paneIntelligence(d, id); },
    };
    paneRendered = {};
    var active = document.querySelector(".ads-tabs .ads-tab.active");
    activate(active ? active.getAttribute("data-tab") : "overview");
  }

  async function triggerRefresh(id) {
    setMsg("Refreshing dossier…", "info");
    var r = await api("/api/profilers/" + encodeURIComponent(id) + "/run", { method: "POST" });
    if (!r) { setMsg("Refresh failed.", "err"); return; }
    if (r.error === "rate_limited") {
      setMsg("Rate-limited (1 run / 7 days). Next eligible " + fmtDate(r.next_eligible_at) + ". Operators can force-refresh from the API.", "warn");
      return;
    }
    setMsg("Refresh queued (run " + (r.run_id || "?").slice(0, 8) + "). Reload in ~30s.", "ok");
  }

  // ---- boot -----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    var id = qsId();
    if (!id) {
      document.getElementById("ads-person-empty").hidden = false;
      return;
    }
    document.getElementById("ads-person-header").hidden = false;
    document.getElementById("ads-person-layout").hidden = false;

    document.querySelectorAll(".ads-person-tabs .ads-tab").forEach(function (t) {
      t.addEventListener("click", function () { activate(t.getAttribute("data-tab")); });
    });
    var initial = (location.hash || "").replace(/^#/, "");
    if (initial && document.querySelector('[data-tab="' + initial + '"]')) activate(initial);

    document.getElementById("ads-person-refresh").addEventListener("click", function () { triggerRefresh(id); });
    document.getElementById("ads-person-copy").addEventListener("click", function () {
      try { navigator.clipboard.writeText(location.href); setMsg("Link copied.", "ok"); } catch (e) { setMsg("Copy failed.", "err"); }
    });
    document.getElementById("ads-person-comment-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var ta = e.target.elements["body"];
      var text = (ta.value || "").trim();
      if (!text) return;
      var r = await api("/api/profile-comments/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (r && r.ok) { ta.value = ""; loadComments(id); }
      else { setMsg((r && r.error) || "Could not post comment.", "err"); }
    });

    // Fire a one-shot "dossier opened" audit entry.
    api("/api/profilers/" + encodeURIComponent(id) + "/audit",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dossier_view" }) });

    loadDossier(id);
    loadSources(id);
    loadChangelog(id);
    loadComments(id);
  });
})();
