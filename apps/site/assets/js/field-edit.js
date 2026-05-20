// Task #3: Editable Profiles + Manual Overrides with Audit.
//
// Progressive enhancement for any element marked with
// data-predicate="<name>" and data-entity-id="<id>". On hover, a small
// pencil button appears; click to inline-edit; Save POSTs an override
// row through /api/entities/:id/overrides (requires a reason on first
// edit). Saved fields show a lock icon; clicking the lock opens a side
// panel with the full edit history (overrides + AI attempts) via
// /api/entities/:id/overrides/:predicate/history.
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

  async function postOverride(entityId, predicate, value, reason) {
    var body = { predicate: predicate, override_reason: reason };
    if (typeof value === "number") body.value_numeric = value;
    else body.value_text = String(value);
    var res = await fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("save_failed:" + res.status);
    return res.json();
  }

  async function fetchHistory(entityId, predicate) {
    var res = await fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides/" + encodeURIComponent(predicate) + "/history", { credentials: "include" });
    if (!res.ok) throw new Error("history_failed:" + res.status);
    return res.json();
  }

  async function unlockOverride(entityId, overrideId, reason) {
    var res = await fetch(API + "/api/entities/" + encodeURIComponent(entityId) + "/overrides/" + encodeURIComponent(overrideId) + "/unlock", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason || "" }),
    });
    if (!res.ok) throw new Error("unlock_failed:" + res.status);
    return res.json();
  }

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

  function decorate(target) {
    if (target.dataset.adsFieldEditDecorated) return;
    target.dataset.adsFieldEditDecorated = "1";
    var entityId = target.dataset.entityId;
    var predicate = target.dataset.predicate;
    if (!entityId || !predicate) return;
    target.style.position = target.style.position || "relative";

    var pencil = el("button", {
      type: "button", title: "Edit", class: "ads-field-edit-btn",
      style: "margin-left:6px;border:none;background:transparent;cursor:pointer;font-size:12px;opacity:0.4",
      onclick: function (ev) {
        ev.stopPropagation();
        var current = target.dataset.currentValue || target.textContent || "";
        var nv = prompt("New value for " + predicate + ":", current);
        if (nv == null) return;
        var reason = prompt("Reason for override (required):", "");
        if (!reason) { alert("Reason required."); return; }
        postOverride(entityId, predicate, nv, reason).then(function () {
          target.textContent = nv;
          target.dataset.currentValue = nv;
          target.appendChild(pencil);
          target.appendChild(lock);
          lock.style.display = "";
        }).catch(function (e) { alert("Save failed: " + (e.message || e)); });
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

  function scan(root) {
    (root || document).querySelectorAll("[data-predicate][data-entity-id]").forEach(decorate);
  }

  document.addEventListener("DOMContentLoaded", function () { scan(document); });
  // Re-scan periodically so async-rendered profile panes pick up.
  setInterval(function () { scan(document); }, 2000);

  // ----- Create-entity modal helper, exposed as window.adsOpenCreateEntity -----
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
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { alert("Create failed: " + JSON.stringify(res.j)); return; }
        var path = kind === "person" ? "/dashboard/people/?id=" : "/dashboard/companies/detail/?id=";
        location.href = path + encodeURIComponent(res.j.id);
      })
      .catch(function (e) { alert("Create failed: " + (e.message || e)); });
  };

  // ----- Bulk edit field helper, exposed as window.adsOpenBulkFieldEdit -----
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
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { alert("Bulk save failed: " + JSON.stringify(res.j)); return; }
        alert("Bulk override written for " + res.j.written + " entities. bulk_operation_id=" + res.j.bulk_operation_id);
      })
      .catch(function (e) { alert("Bulk save failed: " + (e.message || e)); });
  };
})();
