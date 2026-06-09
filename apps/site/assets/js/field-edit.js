// Task #3: Editable Profiles + Manual Overrides with Audit.
//
// Three UI surfaces:
//   1. Inline-edit decorator for any element marked
//      data-predicate="<name>" + data-entity-id="<id>". Hover shows
//      a pencil; click swaps the value span for an <input> with Save
//      / Cancel + an inline reason input (required on first edit).
//      Saved fields show a 🔒 that opens a side-panel history viewer
//      (overrides + AI attempts) with an Unlock control.
//   2. Profile Actions menu — auto-injected on every dashboard profile
//      page detected via <body data-entity-id="..."> or ?id= in the
//      URL. Surfaces "Edit field…", "Delete", "Merge into…", and
//      "Audit log".
//   3. List-page toolbar — auto-injected into known list filter forms
//      (people/investor/company/firm). Surfaces "+ Create entity" and
//      "Bulk edit field…" buttons.
//
// All deep links use ?id=<entity_id> query strings per the Task #4
// static-routing constraint.
(function () {
  if (window.adsFieldEditMounted) return;
  window.adsFieldEditMounted = true;

  var API = "https://api.aidatasignal.com";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "style") node.setAttribute("style", attrs[k]);
      else if (k === "class") node.className = attrs[k];
      else if (k.indexOf("on") === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }
  function fmt(v) { return v == null || v === "" ? "—" : String(v); }
  function jsonOrText(res) { return res.text().then(function (t) { try { return JSON.parse(t); } catch { return { raw: t }; } }); }

  // ---------- API wrappers ----------
  // These throwing helpers route through the shared adsUtil.apiFetch
  // (credentials + error + JSON parsing). Content-Type is kept as-is to
  // preserve existing request behavior; the inline create/merge/delete
  // handlers below still use raw fetch because they need the response body
  // on failure (page logic, out of scope here).
  function postOverride(entityId, predicate, value, reason) {
    var body = { predicate: predicate, override_reason: reason };
    if (typeof value === "number" && !isNaN(value)) body.value_numeric = value;
    else body.value_text = String(value);
    return window.adsUtil.apiFetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }
  function fetchHistory(entityId, predicate) {
    return window.adsUtil.apiFetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides/" + encodeURIComponent(predicate) + "/history");
  }
  function unlockOverride(entityId, overrideId, reason) {
    return window.adsUtil.apiFetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides/" + encodeURIComponent(overrideId) + "/unlock", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason || "" }),
    });
  }
  function fetchAuditLog(entityId) {
    return window.adsUtil.apiFetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/audit-log");
  }

  // ---------- History side-panel ----------
  function openHistoryPanel(entityId, predicate) {
    var existing = document.getElementById("ads-field-history-panel");
    if (existing) existing.remove();
    var panel = el("aside", { id: "ads-field-history-panel", style: "position:fixed;top:0;right:0;bottom:0;width:420px;max-width:90vw;background:#fff;color:#1a1a1a;border-left:1px solid #ccc;box-shadow:-4px 0 16px rgba(0,0,0,.08);padding:16px;overflow:auto;z-index:9999" });
    panel.appendChild(el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px" }, [
      el("strong", null, ["Edit history: " + predicate]),
      el("button", { type: "button", onclick: function () { panel.remove(); }, style: "border:none;background:transparent;font-size:18px;cursor:pointer" }, ["×"]),
    ]));
    var body = el("div", null, [el("p", { class: "ads-muted" }, ["Loading…"])]);
    panel.appendChild(body);
    document.body.appendChild(panel);
    fetchHistory(entityId, predicate).then(function (data) {
      body.innerHTML = "";
      body.appendChild(el("h4", null, ["Overrides"]));
      (data.overrides || []).forEach(function (o) {
        var row = el("div", { style: "padding:8px;border:1px solid #eee;margin-bottom:6px;border-radius:4px" }, [
          el("div", null, [el("strong", null, [fmt(o.value_text != null ? o.value_text : (o.value_numeric != null ? String(o.value_numeric) : ""))])]),
          el("div", { class: "ads-muted", style: "font-size:11px" }, [
            (o.locked ? "🔒 locked" : "🔓 unlocked") + " · by " + (o.overridden_by_email || "—") + " · " + (o.overridden_at || "") + (o.override_reason ? " · " + o.override_reason : ""),
          ]),
        ]);
        if (o.locked) {
          row.appendChild(el("button", {
            type: "button", style: "margin-top:4px;font-size:11px",
            onclick: function () {
              var reason = window.prompt("Reason for unlock?", "");
              if (reason == null) return;
              unlockOverride(entityId, o.id, reason).then(function () { openHistoryPanel(entityId, predicate); });
            },
          }, ["Unlock"]));
        }
        body.appendChild(row);
      });
      body.appendChild(el("h4", null, ["AI / scrape attempts"]));
      (data.attempts || []).forEach(function (a) {
        body.appendChild(el("div", { style: "padding:6px;border-left:3px solid " + (a.superseded_by_override ? "#f59" : "#999") + ";margin-bottom:4px" }, [
          el("div", null, [fmt(a.value_text != null ? a.value_text : (a.value_number != null ? String(a.value_number) : ""))]),
          el("div", { class: "ads-muted", style: "font-size:11px" }, [
            (a.source_kind || "?") + " · " + (a.source || "—") + " · " + (a.observed_at || "") + (a.superseded_by_override ? " · superseded_by_override" : ""),
          ]),
        ]));
      });
    }).catch(function (e) { body.innerHTML = "<p class='ads-muted'>Failed to load: " + (e.message || e) + "</p>"; });
  }

  // ---------- Audit-log side-panel ----------
  function openAuditPanel(entityId) {
    var existing = document.getElementById("ads-audit-panel");
    if (existing) existing.remove();
    var panel = el("aside", { id: "ads-audit-panel", style: "position:fixed;top:0;right:0;bottom:0;width:520px;max-width:95vw;background:#fff;color:#1a1a1a;border-left:1px solid #ccc;box-shadow:-4px 0 16px rgba(0,0,0,.08);padding:16px;overflow:auto;z-index:9999" });
    panel.appendChild(el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px" }, [
      el("strong", null, ["Audit log"]),
      el("button", { type: "button", onclick: function () { panel.remove(); }, style: "border:none;background:transparent;font-size:18px;cursor:pointer" }, ["×"]),
    ]));
    var body = el("div", null, [el("p", { class: "ads-muted" }, ["Loading…"])]);
    panel.appendChild(body);
    document.body.appendChild(panel);
    fetchAuditLog(entityId).then(function (data) {
      body.innerHTML = "";
      (data.items || []).forEach(function (it) {
        body.appendChild(el("div", { style: "padding:8px;border-bottom:1px solid #eee" }, [
          el("div", null, [el("strong", null, [it.action]), " · ", el("span", { class: "ads-muted" }, [it.created_at])]),
          el("div", { class: "ads-muted", style: "font-size:11px" }, ["by " + (it.actor_email || "—")]),
          el("pre", { style: "font-size:11px;white-space:pre-wrap;margin:4px 0;background:#f7f7f7;padding:4px;border-radius:3px" }, [JSON.stringify(it.payload_json, null, 2)]),
        ]));
      });
      if (!(data.items || []).length) body.appendChild(el("p", { class: "ads-muted" }, ["No audit entries yet."]));
    }).catch(function (e) { body.innerHTML = "<p class='ads-muted'>Failed to load: " + (e.message || e) + "</p>"; });
  }

  // ---------- Inline-edit decorator (true hover→input→save, no prompt) ----------
  // A decorated container has this DOM shape:
  //   <span data-ads-field-edit-decorated="1">
  //     <span data-ads-field-value>…current value…</span>
  //     <button class="ads-field-edit-btn">✎</button>
  //     <button class="ads-field-lock-btn">🔒</button>
  //     <span class="ads-field-edit-form" hidden>… input + save/cancel + reason …</span>
  //   </span>
  // Save only mutates [data-ads-field-value] and the lock visibility,
  // so the pencil + lock + form siblings survive a save round trip
  // (the prior implementation called textContent = nv on the whole
  // container, which wiped them — fixed here).
  function decorate(target) {
    if (target.dataset.adsFieldEditDecorated) return;
    var entityId = target.dataset.entityId;
    var predicate = target.dataset.predicate;
    if (!entityId || !predicate) return;
    target.dataset.adsFieldEditDecorated = "1";
    target.style.position = target.style.position || "relative";

    // Move the existing text content into a value-span so we can
    // mutate ONLY that span on save without clobbering controls.
    var initialText = target.textContent;
    target.textContent = "";
    var valueSpan = el("span", { "data-ads-field-value": "1" }, [initialText]);
    target.appendChild(valueSpan);

    var pencil = el("button", {
      type: "button", title: "Edit", class: "ads-field-edit-btn",
      style: "margin-left:6px;border:none;background:transparent;cursor:pointer;font-size:12px;opacity:.5",
    }, ["✎"]);
    var lock = el("button", {
      type: "button", title: "Edit history", class: "ads-field-lock-btn",
      style: "margin-left:4px;border:none;background:transparent;cursor:pointer;font-size:12px;display:" + (target.dataset.overridden === "1" ? "" : "none"),
    }, ["🔒"]);
    var form = el("span", {
      class: "ads-field-edit-form", style: "display:none;margin-left:6px;align-items:center;gap:4px",
    });
    target.appendChild(pencil);
    target.appendChild(lock);
    target.appendChild(form);

    lock.addEventListener("click", function (ev) { ev.stopPropagation(); openHistoryPanel(entityId, predicate); });
    pencil.addEventListener("click", function (ev) {
      ev.stopPropagation();
      openInlineEditor();
    });
    target.addEventListener("dblclick", function (ev) {
      // Double-click anywhere on the value also enters edit mode.
      if (form.style.display !== "none") return;
      ev.stopPropagation(); openInlineEditor();
    });

    function openInlineEditor() {
      var current = target.dataset.currentValue || valueSpan.textContent.trim();
      form.innerHTML = "";
      var input = el("input", { type: "text", value: current, style: "padding:2px 4px;border:1px solid #aaa;border-radius:3px;font:inherit;min-width:160px;color:#1a1a1a;background:#fff" });
      var reasonInput = el("input", { type: "text", placeholder: "reason (required)", style: "padding:2px 4px;border:1px solid #aaa;border-radius:3px;font:inherit;min-width:120px;color:#1a1a1a;background:#fff" });
      var saveBtn = el("button", { type: "button", style: "padding:2px 8px;background:#0a7;color:#fff;border:none;border-radius:3px;cursor:pointer" }, ["Save"]);
      var cancelBtn = el("button", { type: "button", style: "padding:2px 8px;background:#eee;color:#1a1a1a;border:1px solid #ccc;border-radius:3px;cursor:pointer" }, ["Cancel"]);
      var status = el("span", { class: "ads-muted", style: "font-size:11px;margin-left:4px" });

      function close() { form.style.display = "none"; form.innerHTML = ""; valueSpan.style.display = ""; pencil.style.display = ""; }
      function save() {
        var nv = input.value;
        var reason = reasonInput.value.trim();
        if (!reason) { status.textContent = "reason required"; reasonInput.focus(); return; }
        saveBtn.disabled = true; status.textContent = "saving…";
        postOverride(entityId, predicate, nv, reason).then(function () {
          // Only touch the value-span and the lock badge — controls survive.
          valueSpan.textContent = nv;
          target.dataset.currentValue = nv;
          target.dataset.overridden = "1";
          lock.style.display = "";
          close();
        }).catch(function (e) {
          saveBtn.disabled = false; status.textContent = "save failed: " + (e.message || e);
        });
      }
      saveBtn.addEventListener("click", save);
      cancelBtn.addEventListener("click", close);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); save(); }
        else if (e.key === "Escape") { e.preventDefault(); close(); }
      });
      form.appendChild(input); form.appendChild(reasonInput); form.appendChild(saveBtn); form.appendChild(cancelBtn); form.appendChild(status);
      valueSpan.style.display = "none";
      pencil.style.display = "none";
      form.style.display = "inline-flex";
      input.focus(); input.select();
    }
  }

  // ---------- Actions menu (auto-injected on profile pages) ----------
  // Detect "we are viewing a single entity" by the URL ?id= on any
  // /dashboard/ page. Earlier versions had a path-regex carve-out that
  // accidentally excluded /dashboard/people/?id=... — fixed here. We
  // also auto-stamp body[data-entity-id] so other scripts can read it.
  function detectEntityId() {
    var b = document.body;
    if (b && b.dataset.entityId) return b.dataset.entityId;
    var marker = document.querySelector("[data-ads-entity-id]");
    if (marker) return marker.getAttribute("data-ads-entity-id");
    if (!/\/dashboard\//.test(location.pathname)) return null;
    var qs = new URLSearchParams(location.search);
    var id = qs.get("id");
    if (!id) return null;
    // The /dashboard/ list pages (people/, companies/, investors/,
    // firms/) never use ?id= — they use ?q=, ?sector=, etc. So an
    // ?id= present on any /dashboard/ path is a per-entity dossier.
    if (b) b.dataset.entityId = id;
    return id;
  }

  // ---------- data-k → predicate mapping (auto-decoration) ----------
  // The existing detail-page templates (firm-detail, company-detail,
  // investor-detail) tag every rendered field with `data-k="<key>"`.
  // This table maps those keys to canonical predicates so the inline
  // editor lights up on every visible field WITHOUT having to refactor
  // each renderer to emit data-predicate inline.
  var DATA_K_PREDICATE_MAP = {
    name: "display_name",
    hq: "hq_location",
    founded: "founded_year",
    aum: "aum_usd",
    lead_or_co: "lead_or_co",
    website: "website",
    thesis: "thesis",
    stages: "stages",
    sectors: "sectors",
    geo_focus: "geo_focus",
    check_typical: "check_size_typical_usd",
    check_range: "check_size_range",
    contact_email: "contact_email",
    description: "description",
    title: "title",
    role: "title",
    stage: "stage",
    sector: "sector",
    country: "country_iso2",
    city: "location_city",
    region: "location_region",
    headline: "headline",
    summary: "summary",
  };
  function autoDecorateByDataK(entityId) {
    if (!entityId) return;
    document.querySelectorAll("[data-k]").forEach(function (el) {
      if (el.dataset.adsFieldEditDecorated) return;
      var key = el.getAttribute("data-k");
      var pred = DATA_K_PREDICATE_MAP[key];
      if (!pred) return;
      // Don't decorate <img>, <a> (anchor handled below), <input>.
      var tag = el.tagName.toLowerCase();
      if (tag === "img" || tag === "input" || tag === "select") return;
      el.dataset.predicate = pred;
      el.dataset.entityId = entityId;
      decorate(el);
    });
  }

  function injectActionsMenu() {
    var entityId = detectEntityId();
    if (!entityId) return;
    if (document.getElementById("ads-profile-actions")) return;
    var bar = el("div", { id: "ads-profile-actions", style: "position:fixed;bottom:16px;right:16px;z-index:9000;background:#111;color:#fff;padding:8px 12px;border-radius:24px;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:13px;display:flex;gap:8px;align-items:center" }, [
      el("span", { style: "opacity:.7;margin-right:4px" }, ["Profile actions"]),
      btn("Edit field…", function () { openAdHocEditor(entityId); }),
      btn("Delete", function () {
        var reason = window.prompt("Reason for soft-delete (required):", "");
        if (!reason) return;
        fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/soft-delete", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason }),
        }).then(function (r) { return jsonOrText(r).then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) { if (!res.ok) alert("Delete failed: " + JSON.stringify(res.j)); else alert("Soft-deleted."); });
      }, "#900"),
      btn("Merge into…", function () {
        var target = window.prompt("Target entity_id:", "");
        if (!target) return;
        if (!confirm("Merge this entity into " + target + "?")) return;
        fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/merge", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_entity_id: target }),
        }).then(function (r) { return jsonOrText(r).then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok) { alert("Merge failed: " + JSON.stringify(res.j)); return; }
            alert("Merged. Redirecting to primary entity…");
            var prim = (res.j && res.j.primary_id) || target;
            location.search = "?id=" + encodeURIComponent(prim);
          });
      }),
      btn("Audit log", function () { openAuditPanel(entityId); }),
    ]);
    document.body.appendChild(bar);
  }

  function btn(label, onclick, bg) {
    return el("button", {
      type: "button", style: "background:" + (bg || "#fff") + ";color:" + (bg ? "#fff" : "#111") + ";border:none;padding:5px 10px;border-radius:14px;cursor:pointer;font-size:12px",
      onclick: onclick,
    }, [label]);
  }

  // Inline modal editor for "Edit field…" when there is no matching
  // decorated field on the page (e.g. user wants to override a
  // predicate that isn't currently rendered).
  function openAdHocEditor(entityId) {
    var existing = document.getElementById("ads-adhoc-editor"); if (existing) existing.remove();
    var modal = el("div", { id: "ads-adhoc-editor", style: "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9500;display:flex;align-items:center;justify-content:center" });
    var card = el("div", { style: "background:#fff;color:#1a1a1a;padding:16px;border-radius:6px;min-width:320px;display:flex;flex-direction:column;gap:8px" }, [
      el("h4", { style: "margin:0;color:#1a1a1a" }, ["Add override"]),
      el("label", null, ["Predicate (e.g. title, sector)"]),
    ]);
    var predInput = el("input", { type: "text", style: "padding:4px;border:1px solid #aaa;border-radius:3px;color:#1a1a1a;background:#fff" });
    var valInput = el("input", { type: "text", placeholder: "new value", style: "padding:4px;border:1px solid #aaa;border-radius:3px;color:#1a1a1a;background:#fff" });
    var reasonInput = el("input", { type: "text", placeholder: "reason (required)", style: "padding:4px;border:1px solid #aaa;border-radius:3px;color:#1a1a1a;background:#fff" });
    var status = el("div", { class: "ads-muted", style: "font-size:12px;min-height:16px" });
    var saveBtn = el("button", { type: "button", style: "padding:6px 12px;background:#0a7;color:#fff;border:none;border-radius:3px;cursor:pointer" }, ["Save"]);
    var cancelBtn = el("button", { type: "button", style: "padding:6px 12px;background:#eee;border:1px solid #ccc;border-radius:3px;cursor:pointer" }, ["Cancel"]);
    card.appendChild(predInput);
    card.appendChild(el("label", null, ["Value"])); card.appendChild(valInput);
    card.appendChild(el("label", null, ["Reason"])); card.appendChild(reasonInput);
    card.appendChild(status);
    card.appendChild(el("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [cancelBtn, saveBtn]));
    modal.appendChild(card); document.body.appendChild(modal);
    cancelBtn.addEventListener("click", function () { modal.remove(); });
    saveBtn.addEventListener("click", function () {
      var pred = predInput.value.trim(); if (!pred) { status.textContent = "predicate required"; return; }
      var reason = reasonInput.value.trim(); if (!reason) { status.textContent = "reason required"; return; }
      saveBtn.disabled = true; status.textContent = "saving…";
      postOverride(entityId, pred, valInput.value, reason).then(function () { status.textContent = "saved."; setTimeout(function () { modal.remove(); }, 400); })
        .catch(function (e) { saveBtn.disabled = false; status.textContent = "save failed: " + (e.message || e); });
    });
    predInput.focus();
  }

  // ---------- List-page toolbar ----------
  function injectListToolbar() {
    var filtersForm = document.getElementById("ads-people-filters")
      || document.getElementById("ads-investors-filters")
      || document.getElementById("ads-companies-filters")
      || document.getElementById("ads-firms-filters");
    if (!filtersForm) return;
    if (filtersForm.parentNode && filtersForm.parentNode.querySelector(".ads-list-toolbar")) return;
    var toolbar = el("div", { class: "ads-list-toolbar", style: "display:flex;gap:8px;align-items:center;margin:8px 0" }, [
      el("button", { type: "button", style: "background:#0a7;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer", onclick: function () { window.adsOpenCreateEntity({}); } }, ["+ Create entity"]),
      el("button", {
        type: "button", style: "background:#fff;color:#111;border:1px solid #ccc;padding:6px 12px;border-radius:4px;cursor:pointer",
        onclick: function () {
          var ids = (window.adsGetSelectedEntityIds && window.adsGetSelectedEntityIds()) || [];
          if (!ids.length) {
            var manual = window.prompt("No row selection found. Enter comma-separated entity IDs for bulk edit:", "");
            if (!manual) return;
            ids = manual.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
          }
          window.adsOpenBulkFieldEdit(ids);
        },
      }, ["Bulk edit field…"]),
    ]);
    filtersForm.parentNode.insertBefore(toolbar, filtersForm.nextSibling);
  }

  // ---------- Public helpers ----------
  window.adsOpenCreateEntity = function (defaults) {
    var d = defaults || {};
    var name = window.prompt("Name:", d.name || ""); if (!name) return;
    var kind = (d.kind || window.prompt("Kind (person|org):", "org") || "").toLowerCase();
    if (kind !== "person" && kind !== "org") { alert("kind must be person or org"); return; }
    var role = d.primary_role || window.prompt("Primary role (optional, e.g. founder, investor, firm):", "") || null;
    var website = d.website || window.prompt("Website (optional):", "") || null;
    var fillAi = confirm("Run AI fill on save?");
    var url = API + "/api/entities" + (fillAi ? "?fill=ai" : "");
    fetch(url, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, kind: kind, primary_role: role, website: website }),
    }).then(function (r) { return jsonOrText(r).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { alert("Create failed: " + JSON.stringify(res.j)); return; }
        var path = kind === "person" ? "/dashboard/people/?id=" : "/dashboard/companies/detail/?id=";
        location.href = path + encodeURIComponent(res.j.id);
      })
      .catch(function (e) { alert("Create failed: " + (e.message || e)); });
  };

  window.adsOpenBulkFieldEdit = function (entityIds) {
    if (!Array.isArray(entityIds) || !entityIds.length) { alert("No entities selected."); return; }
    var predicate = window.prompt("Predicate (e.g. title, sector, country_iso2):", ""); if (!predicate) return;
    var value = window.prompt("New value:", ""); if (value == null) return;
    var reason = window.prompt("Reason for bulk override (required):", ""); if (!reason) { alert("Reason required."); return; }
    fetch(API + "/api/entities/overrides/bulk", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_ids: entityIds, predicate: predicate, value_text: value, override_reason: reason }),
    }).then(function (r) { return jsonOrText(r).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { alert("Bulk save failed: " + JSON.stringify(res.j)); return; }
        alert("Bulk override written for " + res.j.written + " entities. bulk_operation_id=" + res.j.bulk_operation_id);
      })
      .catch(function (e) { alert("Bulk save failed: " + (e.message || e)); });
  };

  function scan(root) {
    (root || document).querySelectorAll("[data-predicate][data-entity-id]").forEach(decorate);
    // Auto-wire every rendered profile field via the data-k → predicate
    // map so inline editing lights up on detail pages without each
    // renderer having to emit data-predicate inline (Task #3 acceptance:
    // "Every field on every profile page is inline-editable").
    autoDecorateByDataK(detectEntityId());
    injectActionsMenu();
    injectListToolbar();
  }

  document.addEventListener("DOMContentLoaded", function () { scan(document); });
  setInterval(function () { scan(document); }, 2000);
})();
