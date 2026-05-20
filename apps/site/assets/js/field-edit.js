// Task #3: Editable Profiles + Manual Overrides with Audit.
//
// Three surfaces:
//   1. Inline-edit decorator for any element marked
//      data-predicate="<name>" + data-entity-id="<id>". Hover → pencil
//      → input → save (reason required on first edit). Saved fields
//      show a lock icon that opens a side-panel history (overrides +
//      AI attempts) with an Unlock control.
//   2. Actions menu — auto-injected into every profile page detected
//      via <body data-entity-id="..."> or a marker container. Surfaces
//      "Edit field…", "Delete", "Merge into…", and "Audit log".
//      Required by the spec acceptance criteria.
//   3. List-page toolbar — auto-injected into known list filter forms
//      (currently #ads-people-filters). Surfaces "+ Create entity" and
//      "Bulk edit field…" buttons (Task 71 list surface).
//
// Per the Task #4 static-routing constraint, every deep link uses
// `?id=<entity_id>` query strings, never `/:id` path segments.
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

  function jsonOrText(res) {
    return res.text().then(function (t) {
      try { return JSON.parse(t); } catch { return { raw: t }; }
    });
  }

  // ---------- API wrappers ----------
  async function postOverride(entityId, predicate, value, reason) {
    var body = { predicate: predicate, override_reason: reason };
    if (typeof value === "number") body.value_numeric = value;
    else body.value_text = String(value);
    var res = await fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("save_failed:" + res.status);
    return jsonOrText(res);
  }
  async function fetchHistory(entityId, predicate) {
    var res = await fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides/" + encodeURIComponent(predicate) + "/history", { credentials: "include" });
    if (!res.ok) throw new Error("history_failed:" + res.status);
    return jsonOrText(res);
  }
  async function unlockOverride(entityId, overrideId, reason) {
    var res = await fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides/" + encodeURIComponent(overrideId) + "/unlock", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason || "" }),
    });
    if (!res.ok) throw new Error("unlock_failed:" + res.status);
    return jsonOrText(res);
  }
  async function fetchAuditLog(entityId) {
    var res = await fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/audit-log", { credentials: "include" });
    if (!res.ok) throw new Error("audit_failed:" + res.status);
    return jsonOrText(res);
  }

  // ---------- History side-panel ----------
  function openHistoryPanel(entityId, predicate) {
    var existing = document.getElementById("ads-field-history-panel");
    if (existing) existing.remove();
    var panel = el("aside", { id: "ads-field-history-panel", style: "position:fixed;top:0;right:0;bottom:0;width:420px;max-width:90vw;background:#fff;border-left:1px solid #ccc;box-shadow:-4px 0 16px rgba(0,0,0,.08);padding:16px;overflow:auto;z-index:9999" });
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
              var reason = prompt("Reason for unlock?", "");
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
    }).catch(function (e) {
      body.innerHTML = "<p class='ads-muted'>Failed to load: " + (e.message || e) + "</p>";
    });
  }

  // ---------- Audit-log side-panel ----------
  function openAuditPanel(entityId) {
    var existing = document.getElementById("ads-audit-panel");
    if (existing) existing.remove();
    var panel = el("aside", { id: "ads-audit-panel", style: "position:fixed;top:0;right:0;bottom:0;width:520px;max-width:95vw;background:#fff;border-left:1px solid #ccc;box-shadow:-4px 0 16px rgba(0,0,0,.08);padding:16px;overflow:auto;z-index:9999" });
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
    }).catch(function (e) {
      body.innerHTML = "<p class='ads-muted'>Failed to load: " + (e.message || e) + "</p>";
    });
  }

  // ---------- Inline pencil decorator ----------
  function decorate(target) {
    if (target.dataset.adsFieldEditDecorated) return;
    target.dataset.adsFieldEditDecorated = "1";
    var entityId = target.dataset.entityId;
    var predicate = target.dataset.predicate;
    if (!entityId || !predicate) return;
    target.style.position = target.style.position || "relative";

    var pencil = el("button", {
      type: "button", title: "Edit", class: "ads-field-edit-btn",
      style: "margin-left:6px;border:none;background:transparent;cursor:pointer;font-size:12px;opacity:0.5",
      onclick: function (ev) {
        ev.stopPropagation();
        promptAndPostOverride(entityId, predicate, target);
      },
    }, ["✎"]);
    var lock = el("button", {
      type: "button", title: "Edit history", class: "ads-field-lock-btn",
      style: "margin-left:4px;border:none;background:transparent;cursor:pointer;font-size:12px;display:" + (target.dataset.overridden === "1" ? "" : "none"),
      onclick: function (ev) { ev.stopPropagation(); openHistoryPanel(entityId, predicate); },
    }, ["🔒"]);
    target.appendChild(pencil);
    target.appendChild(lock);
  }

  function promptAndPostOverride(entityId, presetPredicate, target) {
    var predicate = presetPredicate || prompt("Predicate name (e.g. title, sector, country_iso2):", "");
    if (!predicate) return;
    var current = target && (target.dataset.currentValue || target.textContent) || "";
    var nv = prompt("New value for " + predicate + ":", current);
    if (nv == null) return;
    var reason = prompt("Reason for override (required):", "");
    if (!reason) { alert("Reason required."); return; }
    postOverride(entityId, predicate, nv, reason).then(function () {
      if (target) {
        target.textContent = nv;
        target.dataset.currentValue = nv;
        target.dataset.overridden = "1";
      }
      alert("Saved.");
    }).catch(function (e) { alert("Save failed: " + (e.message || e)); });
  }

  // ---------- Actions menu (auto-injected on every profile page) ----------
  function detectEntityId() {
    var b = document.body;
    if (b && b.dataset.entityId) return b.dataset.entityId;
    var marker = document.querySelector("[data-ads-entity-id]");
    if (marker) return marker.getAttribute("data-ads-entity-id");
    var qs = new URLSearchParams(location.search);
    var id = qs.get("id");
    // Only auto-inject on dashboard pages — never on list-only pages
    // where the ?id= might be unrelated routing.
    if (id && /\/dashboard\//.test(location.pathname) && !/\bpeople\/?$/.test(location.pathname)) return id;
    return null;
  }

  function injectActionsMenu() {
    var entityId = detectEntityId();
    if (!entityId) return;
    if (document.getElementById("ads-profile-actions")) return;
    var bar = el("div", { id: "ads-profile-actions", style: "position:fixed;bottom:16px;right:16px;z-index:9000;background:#111;color:#fff;padding:8px 12px;border-radius:24px;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:13px;display:flex;gap:8px;align-items:center" }, [
      el("span", { style: "opacity:.7;margin-right:4px" }, ["Profile actions"]),
      btn("Edit field…", function () { promptAndPostOverride(entityId, null, null); }),
      btn("Delete", function () {
        var reason = prompt("Reason for soft-delete (required):", "");
        if (!reason) return;
        fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/soft-delete", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason }),
        }).then(function (r) { return jsonOrText(r).then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) { if (!res.ok) alert("Delete failed: " + JSON.stringify(res.j)); else alert("Soft-deleted."); });
      }, "#900"),
      btn("Merge into…", function () {
        var target = prompt("Target entity_id:", "");
        if (!target) return;
        if (!confirm("Merge this entity into " + target + "?")) return;
        fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/merge-into", {
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

  // ---------- List-page toolbar ----------
  function injectListToolbar() {
    var filtersForm = document.getElementById("ads-people-filters")
      || document.getElementById("ads-investors-filters")
      || document.getElementById("ads-companies-filters")
      || document.getElementById("ads-firms-filters");
    if (!filtersForm) return;
    if (filtersForm.parentNode && filtersForm.parentNode.querySelector(".ads-list-toolbar")) return;
    var toolbar = el("div", { class: "ads-list-toolbar", style: "display:flex;gap:8px;align-items:center;margin:8px 0" }, [
      el("button", {
        type: "button",
        style: "background:#0a7;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer",
        onclick: function () { window.adsOpenCreateEntity({}); },
      }, ["+ Create entity"]),
      el("button", {
        type: "button",
        style: "background:#fff;color:#111;border:1px solid #ccc;padding:6px 12px;border-radius:4px;cursor:pointer",
        onclick: function () {
          var ids = (window.adsGetSelectedEntityIds && window.adsGetSelectedEntityIds()) || [];
          if (!ids.length) {
            var manual = prompt("No row selection found. Enter comma-separated entity IDs for bulk edit:", "");
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
    var name = prompt("Name:", d.name || "");
    if (!name) return;
    var kind = (d.kind || prompt("Kind (person|org):", "org") || "").toLowerCase();
    if (kind !== "person" && kind !== "org") { alert("kind must be person or org"); return; }
    var role = d.primary_role || prompt("Primary role (optional, e.g. founder, investor, firm):", "") || null;
    var website = d.website || prompt("Website (optional):", "") || null;
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
    var predicate = prompt("Predicate (e.g. title, sector, country_iso2):", "");
    if (!predicate) return;
    var value = prompt("New value:", "");
    if (value == null) return;
    var reason = prompt("Reason for bulk override (required):", "");
    if (!reason) { alert("Reason required."); return; }
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
    injectActionsMenu();
    injectListToolbar();
  }

  document.addEventListener("DOMContentLoaded", function () { scan(document); });
  setInterval(function () { scan(document); }, 2000);
})();
