// Task #6: dossier UI for /dashboard/people/?id=<entity_id>.
//
// Consumes:
//   GET    /api/profilers/:id/dossier
//   POST   /api/profilers/:id/run
//   GET    /api/profilers/:id/changelog
//   GET    /api/profilers/:id/sources
//   GET    /api/profile-comments/:id
//   POST   /api/profile-comments/:id
//   DELETE /api/profile-comments/:id/:comment_id
//
// No build step — vanilla JS + the same .ads-* tokens already used by
// every other dashboard page.

(function () {
  // ---- helpers --------------------------------------------------------
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function qsId() {
    var p = new URLSearchParams(location.search);
    // Also support path-based aliases like /people/<id> via a redirect.
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
  // Tiny client-side mirror of the server registry, so predicate keys
  // (e.g. "person.preference.coffee_order") never leak raw to operators.
  // Anything not in the map falls back to a humanized version of the
  // last segment.
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
  // Renders a value with confidence dots and a tooltip showing the
  // evidence URL. `fact` can be either:
  //   - {value, source, evidence_url, confidence}                (loose)
  //   - a raw dossier row (uses .source / .source_url / .confidence)
  function dots(c) {
    var n = Math.max(0, Math.min(5, Math.round(((c == null ? 1 : c) || 0) * 5)));
    var out = "";
    for (var i = 0; i < 5; i++) {
      out += '<span class="ads-fact__dot' + (i < n ? " on" : "") + '"></span>';
    }
    return '<span class="ads-fact__dots" aria-label="confidence ' + n + ' of 5">' + out + "</span>";
  }
  function fact(value, opts) {
    opts = opts || {};
    var url = opts.evidence_url || opts.source_url || "";
    var src = opts.source || opts.source_kind || "";
    var title = src ? src + (url ? "\n" + url : "") : (url || "");
    var inner = '<span class="ads-fact__value">' + esc(value == null ? "—" : value) + "</span>";
    if (url) {
      inner = '<a class="ads-fact__link" href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(title) + '">' + inner + "</a>";
    } else if (title) {
      inner = '<span title="' + esc(title) + '">' + inner + "</span>";
    }
    return '<span class="ads-fact">' + inner + " " + dots(opts.confidence) + "</span>";
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
    var TOTAL = 13; // count of tables tracked by populated_tables
    var completeness = (d.populated_tables || []).length / TOTAL;
    var skipped = (d.privacy_skipped_enrichers || []).length;
    // Authenticity = 1 - (skipped / 30); clamps to [0.3, 1].
    var authenticity = Math.max(0.3, Math.min(1, 1 - skipped / 30));
    // Confidence uses latest_synthesis presence + citation count as a proxy.
    var confBase = d.latest_synthesis ? 0.6 : 0.2;
    var cites = d.latest_synthesis ? (d.latest_synthesis.citations_count || 0) : 0;
    var confidence = Math.min(1, confBase + Math.min(0.4, cites / 25));
    document.getElementById("ads-person-rings").innerHTML =
      ring("Completeness", completeness, "var(--ads-accent)") +
      ring("Confidence",   confidence,   "var(--ads-accent-2)") +
      ring("Authenticity", authenticity, "var(--ads-warn)");
  }

  // ---- pane renderers -------------------------------------------------
  function paneOverview(d) {
    var id = d.identity || {};
    var rows = [];
    function row(label, val, opts) {
      if (val == null || val === "") return;
      rows.push('<tr><th>' + esc(label) + '</th><td>' + fact(val, opts || {}) + '</td></tr>');
    }
    row("Full name", id.full_name, { source: id.source, evidence_url: id.source_url, confidence: id.confidence });
    row("Preferred name", id.preferred_name);
    row("Pronouns", id.pronouns);
    row("Birth year", id.birth_year);
    row("Nationality", id.nationality);
    row("Timezone", id.timezone);
    row("City", id.location_city);
    row("Country", id.location_country);
    var langs = id.languages_json ? safeJson(id.languages_json) : null;
    if (Array.isArray(langs) && langs.length) {
      row("Languages", langs.map(function (l) { return typeof l === "string" ? l : (l.name || l.code); }).join(", "));
    }
    var html = "";
    if (id.headshot_url) {
      html += '<div style="float:right;margin:0 0 12px 16px"><img src="' + esc(id.headshot_url) + '" alt="" style="width:120px;height:120px;border-radius:12px;object-fit:cover;border:1px solid var(--ads-border)"></div>';
    }
    html += rows.length
      ? '<table class="ads-table ads-table--kv">' + rows.join("") + '</table>'
      : emptyCard("No identity fields collected yet.");

    // Skipped enrichers badge strip.
    var skipped = d.privacy_skipped_enrichers || [];
    if (skipped.length) {
      html += '<div style="margin-top:18px"><h3 style="margin-bottom:8px">Skipped for privacy</h3><div class="ads-tag-row">' +
        skipped.map(function (s) {
          return '<span class="ads-pill idle" title="' + esc(s.reason) + '">' + esc(s.enricher_name) + '</span>';
        }).join(" ") + '</div></div>';
    }
    // Populated-tables badge strip.
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
                "<td>" + fact(r.source || "—", { evidence_url: r.source_url, confidence: r.confidence }) + "</td></tr>";
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
        html += '<div style="margin-bottom:14px"><h3 style="margin-bottom:6px">' + esc(label) + '</h3>';
        if (Array.isArray(val)) {
          html += '<ul style="margin:0;padding-left:18px">' + val.map(function (v) {
            return "<li>" + esc(typeof v === "string" ? v : JSON.stringify(v)) + "</li>";
          }).join("") + '</ul>';
        } else if (typeof val === "string") {
          html += '<p style="margin:0;white-space:pre-wrap">' + esc(val) + '</p>';
        } else {
          html += '<pre class="ads-detail__pre">' + esc(JSON.stringify(val, null, 2)) + '</pre>';
        }
        html += '</div>';
      });
    }
    if (!html) html += emptyCard("Nothing to render.");
    document.getElementById("ads-pane-outreach").innerHTML = html;
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
        '<span style="font-size:12px">' + fact(v, { source: f.source, evidence_url: f.evidence_url, confidence: f.confidence }) + "</span></li>";
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

  // ---- tabs -----------------------------------------------------------
  function activate(name) {
    document.querySelectorAll(".ads-person-tabs .ads-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".ads-tab-panel").forEach(function (p) {
      var on = p.getAttribute("data-tab") === name;
      p.classList.toggle("active", on);
      p.hidden = !on;
    });
    try { history.replaceState(null, "", "#" + name); } catch (e) { /* noop */ }
  }

  // ---- top-level load -------------------------------------------------
  async function loadDossier(id) {
    var d = await api("/api/profilers/" + encodeURIComponent(id) + "/dossier");
    if (!d || d.error) {
      document.getElementById("ads-person-name").textContent = "Not found";
      document.getElementById("ads-person-sub").textContent = id;
      document.getElementById("ads-pane-overview").innerHTML = emptyCard((d && d.error) || "Could not load dossier.");
      return;
    }
    var id_ = d.identity || {};
    var display = id_.full_name || id_.preferred_name || ("Entity " + (d.entity_id || "").slice(0, 8));
    document.getElementById("ads-person-name").textContent = display;
    var subBits = [id_.headline, id_.location_city, id_.location_country].filter(Boolean);
    document.getElementById("ads-person-sub").textContent = subBits.join(" · ") || "—";
    document.getElementById("ads-person-summary").textContent = deriveSummary(d);
    var avatar = document.getElementById("ads-person-avatar");
    if (id_.headshot_url) {
      avatar.innerHTML = '<img src="' + esc(id_.headshot_url) + '" alt="">';
      avatar.classList.add("has-img");
    } else {
      avatar.textContent = (display || "?").trim().charAt(0).toUpperCase();
    }
    renderRings(d);
    paneOverview(d);
    paneCareer(d);
    paneBackground(d);
    paneInterests(d);
    paneNetwork(d);
    paneVoice(d);
    paneOutreach(d);
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

    document.getElementById("ads-person-json").href = "https://api.aidatasignal.com/api/profilers/" + encodeURIComponent(id) + "/dossier";

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

    loadDossier(id);
    loadSources(id);
    loadChangelog(id);
    loadComments(id);
  });
})();
