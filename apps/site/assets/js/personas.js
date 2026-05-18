// Task #46 dashboard glue.
//
// Two pages share this file:
//   /dashboard/personas/        → list + counts + top-5 chips
//   /dashboard/personas/edit/   → form + debounced live preview pane
//                                 + Analyze / Rescore / Clone / Archive
//
// API base resolves to https://api.aidatasignal.com when the dashboard
// is served from aidatasignal.com; otherwise relative /api (dev mode).

(function () {
  "use strict";
  var API = (location.hostname === "aidatasignal.com" || location.hostname === "www.aidatasignal.com")
    ? "https://api.aidatasignal.com" : "";

  function $(s, root) { return (root || document).querySelector(s); }
  function $$(s, root) { return Array.from((root || document).querySelectorAll(s)); }
  function escHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" })[c]; }); }
  function fetchJson(path, opts) {
    return fetch(API + path, Object.assign({ credentials: "include" }, opts || {}))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }
  function commaList(s) {
    return String(s || "").split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function fmtDate(s) { if (!s) return "—"; try { return new Date(s).toLocaleString(); } catch (e) { return s; } }

  // ---- list page ----
  function initList() {
    var sel = $("#ads-personas-status");
    var tbody = $("#ads-personas-tbody");
    var count = $("#ads-personas-count");
    if (!tbody) return;

    function render(items) {
      count.textContent = items.length + " persona" + (items.length === 1 ? "" : "s");
      if (!items.length) { tbody.innerHTML = '<tr><td class="ads-muted" colspan="6" style="padding:8px">No personas yet — create your first one.</td></tr>'; return; }
      tbody.innerHTML = items.map(function (p) {
        var top = (p.top5 || []).slice(0, 5).map(function (m) {
          return '<span style="display:inline-block;background:#eef;border-radius:4px;padding:1px 6px;margin:1px;font-size:11px">'
            + escHtml(m.entity_name || m.entity_id) + ' <b>' + Math.round(m.fit_score) + '</b></span>';
        }).join("");
        return '<tr>'
          + '<td style="padding:8px"><a href="/dashboard/personas/edit/?id=' + encodeURIComponent(p.id) + '" style="color:#234">' + escHtml(p.name) + '</a><div class="ads-muted" style="font-size:11px">' + escHtml(p.thesis || "") + '</div></td>'
          + '<td style="padding:8px;font-size:12px">' + escHtml(p.kind) + '</td>'
          + '<td style="padding:8px;text-align:right;font-weight:600">' + (p.fit_count || 0) + '</td>'
          + '<td style="padding:8px">' + (top || '<span class="ads-muted">—</span>') + '</td>'
          + '<td style="padding:8px;font-size:12px">' + fmtDate(p.last_modified) + '</td>'
          + '<td style="padding:8px;text-align:right"><a href="/dashboard/personas/edit/?id=' + encodeURIComponent(p.id) + '">Edit</a></td>'
          + '</tr>';
      }).join("");
    }

    function load() {
      tbody.innerHTML = '<tr><td class="ads-muted" colspan="6" style="padding:8px">Loading…</td></tr>';
      fetchJson("/api/personas?status=" + encodeURIComponent(sel.value)).then(function (r) {
        if (!r.ok) { tbody.innerHTML = '<tr><td colspan="6" style="padding:8px;color:#a33">' + escHtml(r.body && r.body.error || "load failed") + '</td></tr>'; return; }
        render(r.body.items || []);
      });
    }
    sel.addEventListener("change", load);
    load();
  }

  // ---- editor page ----
  // Task #3: persona-kinds taxonomy fetched from the worker. Cached
  // for the page lifetime — drives the grouped <select>, the
  // conditional <fieldset data-section> visibility, and the per-kind
  // hint inputs (subtype, aum_band, stage_focus, etc.).
  var TAXONOMY = null;
  function loadTaxonomy() {
    if (TAXONOMY) return Promise.resolve(TAXONOMY);
    return fetchJson("/api/personas/taxonomy").then(function (r) {
      TAXONOMY = (r.ok && r.body) ? r.body : { groups: [], kinds: [], hints: {} };
      return TAXONOMY;
    });
  }

  function renderKindSelect(sel) {
    if (!TAXONOMY || !TAXONOMY.groups) return;
    var html = "";
    TAXONOMY.groups.forEach(function (g) {
      html += '<optgroup label="' + escHtml(g.group) + '">';
      g.items.forEach(function (it) {
        html += '<option value="' + escHtml(it.kind) + '">' + escHtml(it.label) + '</option>';
      });
      html += '</optgroup>';
    });
    sel.innerHTML = html;
  }

  function kindDef(kind) {
    if (!TAXONOMY || !TAXONOMY.kinds) return null;
    for (var i = 0; i < TAXONOMY.kinds.length; i++) {
      if (TAXONOMY.kinds[i].kind === kind) return TAXONOMY.kinds[i];
    }
    return null;
  }

  function applyKindShape(form, kind) {
    var def = kindDef(kind);
    var allowed = def ? def.sections : [];
    // Show/hide criteria fieldsets by data-section.
    var fsets = form.querySelectorAll("fieldset[data-section]");
    for (var i = 0; i < fsets.length; i++) {
      var sec = fsets[i].getAttribute("data-section");
      fsets[i].style.display = (allowed.indexOf(sec) >= 0) ? "" : "none";
    }
    // Render hint fields.
    var hintsWrap = document.getElementById("ads-persona-hints");
    var hintsBody = document.getElementById("ads-persona-hints-body");
    if (!hintsWrap || !hintsBody) return;
    var hints = (def && def.hints) || [];
    if (!hints.length) { hintsWrap.style.display = "none"; hintsBody.innerHTML = ""; return; }
    hintsWrap.style.display = "";
    var html = "";
    var meta = (TAXONOMY && TAXONOMY.hints) || {};
    hints.forEach(function (h) {
      var m = meta[h] || { label: h, type: "text" };
      var inputName = "hint_" + h;
      if (m.type === "select" && m.options) {
        html += '<label class="ads-field"><span>' + escHtml(m.label) + '</span><select name="' + inputName + '"><option value="">—</option>';
        m.options.forEach(function (o) { html += '<option value="' + escHtml(o) + '">' + escHtml(o) + '</option>'; });
        html += '</select></label>';
      } else {
        var t = m.type === "number" ? "number" : "text";
        var ph = m.placeholder ? ' placeholder="' + escHtml(m.placeholder) + '"' : "";
        html += '<label class="ads-field"><span>' + escHtml(m.label) + '</span><input type="' + t + '" name="' + inputName + '"' + ph + '></label>';
      }
    });
    hintsBody.innerHTML = html;
  }

  function readHintValues(form, kind) {
    var def = kindDef(kind);
    if (!def || !def.hints || !def.hints.length) return null;
    var out = {};
    var fd = new FormData(form);
    def.hints.forEach(function (h) {
      var v = fd.get("hint_" + h);
      if (v != null && String(v) !== "") out[h] = String(v);
    });
    return Object.keys(out).length ? out : null;
  }

  function fillHintValues(form, kind, hardFiltersJson) {
    var def = kindDef(kind);
    if (!def || !def.hints) return;
    var obj = {};
    try { var parsed = typeof hardFiltersJson === "string" ? JSON.parse(hardFiltersJson) : (hardFiltersJson || {}); obj = (parsed && parsed.hints) || {}; } catch (e) {}
    def.hints.forEach(function (h) {
      var el = form.elements["hint_" + h];
      if (el && obj[h] != null) el.value = String(obj[h]);
    });
  }

  function initEditor() {
    var form = $("#ads-persona-form");
    if (!form) return;
    var msg = $("#ads-persona-msg");
    var titleEl = $("#ads-persona-title");
    var preview = $("#ads-persona-preview");
    var previewStatus = $("#ads-persona-preview-status");
    var notesCard = $("#ads-persona-notes-card");
    var notesEl = $("#ads-persona-notes");
    var notesAtEl = $("#ads-persona-notes-at");
    var btnSave = $("#ads-persona-save");
    var btnClone = $("#ads-persona-clone");
    var btnArchive = $("#ads-persona-archive");
    var btnAnalyze = $("#ads-persona-analyze");
    var btnRescore = $("#ads-persona-rescore");
    var qs = new URLSearchParams(location.search);
    var id = qs.get("id") || "";
    var loaded = null;

    function setMsg(text, color) { msg.textContent = text || ""; msg.style.color = color || "#666"; }

    function readForm() {
      var fd = new FormData(form);
      var b = {};
      ["name","thesis","kind"].forEach(function (k) { var v = fd.get(k); if (v != null && v !== "") b[k] = String(v); });
      ["size_min","size_max","semantic_fit_threshold","recency_boost"].forEach(function (k) { var v = fd.get(k); if (v != null && v !== "") b[k] = Number(v); });
      ["geos","industries","techs_required","techs_preferred","techs_excluded","signal_kinds","buyer_titles","buyer_seniority","buyer_departments","size_bands"].forEach(function (k) {
        var arr = commaList(fd.get(k));
        if (arr.length) b[k + "_json"] = arr;
      });
      ["hard_filters_json","weights_json"].forEach(function (k) {
        var v = fd.get(k);
        if (v && String(v).trim()) {
          try { b[k] = JSON.parse(v); } catch (e) { /* leave out — server will ignore unparseable */ }
        }
      });
      // Task #3: merge per-kind hint inputs into hard_filters_json.hints.
      var hints = readHintValues(form, b.kind);
      if (hints) {
        var hf = (b.hard_filters_json && typeof b.hard_filters_json === "object") ? b.hard_filters_json : {};
        hf.hints = hints;
        b.hard_filters_json = hf;
      }
      return b;
    }

    function fillForm(p) {
      form.elements["name"].value = p.name || "";
      // Task #3: legacy 'account'/'buyer' → resolve to new keys for the select.
      var k = p.kind || "account_company";
      if (k === "account") k = "account_company";
      if (k === "buyer") k = "buyer_person";
      form.elements["kind"].value = k;
      applyKindShape(form, k);
      fillHintValues(form, k, p.hard_filters_json);
      form.elements["thesis"].value = p.thesis || "";
      form.elements["size_min"].value = p.size_min == null ? "" : p.size_min;
      form.elements["size_max"].value = p.size_max == null ? "" : p.size_max;
      var setArr = function (k, jsonField) {
        try { var v = p[jsonField]; var arr = typeof v === "string" ? JSON.parse(v) : (v || []); form.elements[k].value = (arr || []).join(", "); }
        catch (e) { form.elements[k].value = ""; }
      };
      setArr("geos","geos_json");
      setArr("industries","industries_json");
      setArr("techs_required","techs_required_json");
      setArr("techs_preferred","techs_preferred_json");
      setArr("techs_excluded","techs_excluded_json");
      setArr("signal_kinds","signal_kinds_json");
      setArr("buyer_titles","buyer_titles_json");
      setArr("buyer_seniority","buyer_seniority_json");
      setArr("buyer_departments","buyer_departments_json");
      setArr("size_bands","size_bands_json");
      try { form.elements["hard_filters_json"].value = p.hard_filters_json ? JSON.stringify(JSON.parse(p.hard_filters_json), null, 2) : ""; } catch (e) { form.elements["hard_filters_json"].value = p.hard_filters_json || ""; }
      try { form.elements["weights_json"].value = p.weights_json ? JSON.stringify(JSON.parse(p.weights_json), null, 2) : ""; } catch (e) { form.elements["weights_json"].value = p.weights_json || ""; }
      form.elements["semantic_fit_threshold"].value = p.semantic_fit_threshold == null ? "" : p.semantic_fit_threshold;
      form.elements["recency_boost"].value = p.recency_boost == null ? "" : p.recency_boost;
      titleEl.textContent = p.name || "Untitled";
      btnClone.hidden = false; btnArchive.hidden = false; btnAnalyze.hidden = false; btnRescore.hidden = false;
      if (p.persona_notes) {
        notesCard.hidden = false; notesEl.textContent = p.persona_notes;
        notesAtEl.textContent = "Generated " + fmtDate(p.notes_generated_at);
      }
    }

    function refreshPreview() {
      var body = readForm();
      previewStatus.textContent = "computing…";
      fetchJson("/api/personas/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) { previewStatus.textContent = "preview failed"; return; }
        var items = r.body.items || [];
        previewStatus.textContent = items.length + " of " + (r.body.candidate_count || 0);
        if (!items.length) { preview.innerHTML = '<li class="ads-muted">No matches above 0 yet.</li>'; return; }
        preview.innerHTML = items.map(function (m) {
          var c = m.components || {};
          var bits = [];
          if (c.size_fit) bits.push("size " + Math.round(c.size_fit));
          if (c.industry_fit) bits.push("ind " + Math.round(c.industry_fit));
          if (c.signal_fit) bits.push("sig " + Math.round(c.signal_fit));
          if (c.buyer_fit) bits.push("buy " + Math.round(c.buyer_fit));
          if (c.semantic_fit) bits.push("sem " + Math.round(c.semantic_fit));
          return '<li style="margin:2px 0"><b>' + Math.round(m.fit_score) + '</b> · ' + escHtml(m.name)
            + ' <span class="ads-muted" style="font-size:11px">(' + bits.join(", ") + ')</span></li>';
        }).join("");
      });
    }

    var debounceTimer = null;
    function schedulePreview() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refreshPreview, 600);
    }
    form.addEventListener("input", schedulePreview);
    form.addEventListener("change", schedulePreview);

    btnSave.addEventListener("click", function (ev) {
      ev.preventDefault();
      var body = readForm();
      if (!body.name) { setMsg("Name is required", "#a33"); return; }
      setMsg("Saving…");
      var path = id ? "/api/personas/" + encodeURIComponent(id) : "/api/personas";
      var method = id ? "PATCH" : "POST";
      fetchJson(path, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
        if (!r.ok) { setMsg(r.body && r.body.message || r.body && r.body.error || "save failed", "#a33"); return; }
        setMsg("Saved · rescore dispatched in background", "#260");
        if (!id && r.body && r.body.id) {
          history.replaceState({}, "", "/dashboard/personas/edit/?id=" + encodeURIComponent(r.body.id));
          id = r.body.id;
        }
        loaded = r.body;
        titleEl.textContent = loaded.name;
        btnClone.hidden = false; btnArchive.hidden = false; btnAnalyze.hidden = false; btnRescore.hidden = false;
      });
    });

    btnArchive.addEventListener("click", async function () {
      if (!id) return;
      if (!(await window.ADS.ui.confirm({ title: "Archive persona?", body: "Match rows will be deleted. This can't be undone.", confirmLabel: "Archive", danger: true }))) return;
      fetchJson("/api/personas/" + encodeURIComponent(id), { method: "DELETE" }).then(function (r) {
        if (!r.ok) { setMsg("archive failed", "#a33"); return; }
        location.href = "/dashboard/personas/";
      });
    });

    btnClone.addEventListener("click", function () {
      if (!id) return;
      fetchJson("/api/personas/" + encodeURIComponent(id) + "/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
        .then(function (r) { if (r.ok && r.body && r.body.id) location.href = "/dashboard/personas/edit/?id=" + encodeURIComponent(r.body.id); else setMsg("clone failed", "#a33"); });
    });

    btnRescore.addEventListener("click", function () {
      if (!id) return;
      setMsg("Rescore dispatched…");
      fetchJson("/api/personas/" + encodeURIComponent(id) + "/rescore-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then(function (r) { setMsg(r.ok ? "Rescore queued" : "rescore failed", r.ok ? "#260" : "#a33"); });
    });

    btnAnalyze.addEventListener("click", function () {
      if (!id) return;
      setMsg("Analyzing top-50…");
      fetchJson("/api/personas/" + encodeURIComponent(id) + "/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then(function (r) {
          if (!r.ok) { setMsg(r.body && r.body.error || "analyze failed", "#a33"); return; }
          notesCard.hidden = false;
          notesEl.textContent = r.body.notes || "";
          notesAtEl.textContent = "Generated just now";
          setMsg("Analysis saved", "#260");
        });
    });

    // Task #3: load taxonomy, populate grouped select, then load
    // persona (if editing) or initialize a blank form.
    loadTaxonomy().then(function () {
      var sel = document.getElementById("ads-persona-kind");
      if (sel) {
        renderKindSelect(sel);
        sel.addEventListener("change", function () {
          applyKindShape(form, sel.value);
          schedulePreview();
        });
      }

      if (id) {
        fetchJson("/api/personas/" + encodeURIComponent(id)).then(function (r) {
          if (!r.ok) { setMsg("not found", "#a33"); return; }
          loaded = r.body;
          fillForm(loaded);
          refreshPreview();
        });
      } else {
        form.elements["kind"].value = "account_company";
        applyKindShape(form, "account_company");
        titleEl.textContent = "New persona";
        refreshPreview();
      }
    });
  }

  if (location.pathname.replace(/\/$/, "") === "/dashboard/personas") initList();
  if (location.pathname.indexOf("/dashboard/personas/edit") === 0) initEditor();
})();
