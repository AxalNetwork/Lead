// Task #2: shared bulk-actions selection model + sticky bottom bar.
//
// Usage from a list page:
//
//   adsBulkBar.init({
//     pageId: 'investors',
//     getRows: () => document.querySelectorAll('#ads-investors-tbody tr[data-id]'),
//     idAttr: 'data-id',                  // attribute on each row holding the entity id
//     fetchAllMatchingIds: async () => {  // optional: server-side "select all matching filter"
//       const r = await window.adsApiFetch('/api/investors?limit=5000&ids_only=1');
//       return (r.items || []).map(x => x.id);
//     },
//     actions: ['assign-role','add-tag','enrich','merge','export','delete']
//   });
//
// The page is responsible for inserting a checkbox column whose cell looks like
// <td><input type="checkbox" class="ads-bulk-check" data-id="<entity_id>"></td>
// and a header checkbox `#ads-bulk-header-check`. The init() call wires the
// rest: selection state, header click semantics, sticky bar, modals, toasts.

(function () {
  var API = window.adsApiBase || "https://api.aidatasignal.com";
  function api(path, opts) {
    var fn = window.adsApiFetch || function (p, o) {
      return fetch(API + p, Object.assign({ credentials: "include" }, o || {})).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { var e = new Error(j.message || ("HTTP " + r.status)); e.body = j; throw e; }, function () { throw new Error("HTTP " + r.status); });
        return r.json();
      });
    };
    return fn(path, opts);
  }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  var ROLES = ["investor", "founder", "operator", "executive", "board_member",
    "advisor", "employee", "customer", "prospect", "buyer", "lead",
    "partner", "firm", "fund", "accelerator", "company", "account"];

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) { for (var k in attrs) { if (k === "class") n.className = attrs[k]; else n.setAttribute(k, attrs[k]); } }
    if (html != null) n.innerHTML = html;
    return n;
  }

  function ensureBar() {
    var existing = document.getElementById("ads-bulk-bar");
    if (existing) return existing;
    var bar = el("div", { id: "ads-bulk-bar", hidden: "true" });
    bar.style.cssText =
      "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);" +
      "background:var(--ads-card,#1a1a1a);color:var(--ads-text,#eee);" +
      "border:1px solid var(--ads-border,#2a2a2a);border-radius:12px;" +
      "padding:10px 14px;display:flex;gap:8px;align-items:center;" +
      "box-shadow:0 6px 24px rgba(0,0,0,0.45);z-index:9999;font-size:13px";
    document.body.appendChild(bar);
    return bar;
  }
  function ensureToastHost() {
    var host = document.getElementById("ads-bulk-toasts");
    if (host) return host;
    host = el("div", { id: "ads-bulk-toasts" });
    host.style.cssText = "position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:10000";
    document.body.appendChild(host);
    return host;
  }
  function toast(html, opts) {
    opts = opts || {};
    var host = ensureToastHost();
    var t = el("div", { class: "ads-bulk-toast" }, html);
    t.style.cssText = "background:var(--ads-card,#1a1a1a);color:var(--ads-text,#eee);" +
      "border:1px solid var(--ads-border,#2a2a2a);border-radius:8px;padding:10px 12px;max-width:380px;box-shadow:0 4px 16px rgba(0,0,0,0.4)";
    host.appendChild(t);
    var ttl = opts.ttl || 8000;
    setTimeout(function () { try { host.removeChild(t); } catch (e) {} }, ttl);
    return t;
  }

  function ensureModalHost() {
    var host = document.getElementById("ads-bulk-modal");
    if (host) return host;
    host = el("div", { id: "ads-bulk-modal" });
    host.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:10001";
    host.innerHTML = '<div id="ads-bulk-modal-card" style="background:var(--ads-card,#1a1a1a);color:var(--ads-text,#eee);border:1px solid var(--ads-border,#2a2a2a);border-radius:12px;padding:18px;max-width:520px;width:90%;font-size:13px"></div>';
    document.body.appendChild(host);
    return host;
  }
  function openModal(innerHtml) {
    var host = ensureModalHost();
    host.style.display = "flex";
    host.querySelector("#ads-bulk-modal-card").innerHTML = innerHtml;
    return host;
  }
  function closeModal() {
    var host = document.getElementById("ads-bulk-modal");
    if (host) host.style.display = "none";
  }

  function init(cfg) {
    cfg = cfg || {};
    // Filter-signature-keyed selection persistence: a selection set is
    // scoped to the (pageId, filter signature) tuple and survives
    // re-renders, "Load more", and full reloads via sessionStorage. As
    // soon as the filter signature changes, the selection is dropped so
    // operators don't accidentally apply a bulk action to a different
    // result set than the one currently on screen.
    var SIG_KEY = "adsBulkBar:" + (cfg.pageId || "default");
    function readPersisted() {
      try {
        var raw = sessionStorage.getItem(SIG_KEY);
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (!p || typeof p !== "object") return null;
        return p; // { sig, ids: [], allMatching: bool }
      } catch (e) { return null; }
    }
    function persist() {
      try {
        sessionStorage.setItem(SIG_KEY, JSON.stringify({
          sig: currentSignature,
          ids: Array.from(selection.keys()),
          allMatching: allMatchingMode,
        }));
      } catch (e) { /* quota: ignore */ }
    }

    var selection = new Map();      // id -> true
    var allMatchingMode = false;    // true after 2nd header click
    var currentSignature = cfg.getFilterSignature ? cfg.getFilterSignature() : "";
    var headerCheck = document.getElementById("ads-bulk-header-check");

    // Rehydrate selection on init iff the persisted signature matches
    // the current filter signature. Drop otherwise.
    var persisted = readPersisted();
    if (persisted && persisted.sig === currentSignature && Array.isArray(persisted.ids)) {
      persisted.ids.forEach(function (id) { selection.set(String(id), true); });
      allMatchingMode = persisted.allMatching === true;
    } else if (persisted) {
      try { sessionStorage.removeItem(SIG_KEY); } catch (e) {}
    }

    function rowChecks() {
      var rows = cfg.getRows ? cfg.getRows() : document.querySelectorAll(".ads-bulk-check");
      return Array.from(rows).map(function (r) {
        if (r.tagName === "INPUT") return r;
        return r.querySelector("input.ads-bulk-check");
      }).filter(Boolean);
    }

    function refreshBar() {
      var bar = ensureBar();
      var n = selection.size;
      if (!n) { bar.hidden = true; return; }
      bar.hidden = false;
      var actions = cfg.actions || ["assign-role", "add-tag", "enrich", "merge", "export", "delete"];
      var btns = "";
      if (actions.indexOf("assign-role") >= 0) btns += '<button class="ads-btn ads-btn--sm" data-act="assign-role">Assign role ▾</button>';
      if (actions.indexOf("add-tag") >= 0) btns += '<button class="ads-btn ads-btn--sm" data-act="add-tag">Add tag</button>';
      if (actions.indexOf("enrich") >= 0) btns += '<button class="ads-btn ads-btn--sm" data-act="enrich">Enrich now</button>';
      if (actions.indexOf("merge") >= 0) btns += '<button class="ads-btn ads-btn--sm" data-act="merge">Merge…</button>';
      if (actions.indexOf("export") >= 0) btns += '<button class="ads-btn ads-btn--sm" data-act="export">Export CSV</button>';
      if (actions.indexOf("delete") >= 0) btns += '<button class="ads-btn ads-btn--sm" data-act="delete">Delete</button>';
      btns += '<button class="ads-btn ads-btn--sm ads-btn--ghost" data-act="cancel">Cancel</button>';
      var note = allMatchingMode ? ' <span class="ads-muted">(all matching, cap 5000)</span>' : '';
      bar.innerHTML = '<strong>' + n + '</strong> selected' + note + ' · ' + btns;
    }

    function syncCheckboxes() {
      rowChecks().forEach(function (c) {
        c.checked = selection.has(c.getAttribute("data-id"));
      });
    }

    function bindRowChecks() {
      rowChecks().forEach(function (c) {
        if (c.__adsBulkBound) return;
        c.__adsBulkBound = true;
        c.addEventListener("change", function () {
          var id = c.getAttribute("data-id");
          if (c.checked) selection.set(id, true); else selection["delete"](id);
          allMatchingMode = false;
          refreshBar();
        });
      });
    }

    function selectPage(check) {
      rowChecks().forEach(function (c) {
        var id = c.getAttribute("data-id");
        if (check) selection.set(id, true); else selection["delete"](id);
        c.checked = check;
      });
      refreshBar();
    }

    async function selectAllMatching() {
      if (!cfg.fetchAllMatchingIds) { selectPage(true); return; }
      try {
        var ids = await cfg.fetchAllMatchingIds();
        ids = (ids || []).slice(0, 5000);
        selection.clear();
        ids.forEach(function (id) { selection.set(id, true); });
        allMatchingMode = true;
        syncCheckboxes();
        refreshBar();
      } catch (e) {
        toast("Failed to select all matching: " + esc(e.message));
      }
    }

    if (headerCheck) {
      var headerClicks = 0;
      headerCheck.addEventListener("click", function () {
        headerClicks += 1;
        if (headerClicks === 1) { selectPage(headerCheck.checked); }
        else { headerClicks = 0; selectAllMatching(); }
        setTimeout(function () { headerClicks = 0; }, 2500);
      });
    }

    // Rebind row checks after each list refresh — pages call this manually
    // (or use a MutationObserver as a fallback).
    var rowHost = cfg.getRowHost ? cfg.getRowHost() : document.body;
    var mo = new MutationObserver(function () { bindRowChecks(); syncCheckboxes(); });
    if (rowHost) mo.observe(rowHost, { childList: true, subtree: true });
    bindRowChecks();

    document.addEventListener("click", function (e) {
      var btn = e.target.closest("#ads-bulk-bar button[data-act]");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      if (act === "cancel") { selection.clear(); allMatchingMode = false; syncCheckboxes(); refreshBar(); return; }
      var ids = Array.from(selection.keys());
      if (act === "assign-role") return openAssignRole(ids);
      if (act === "add-tag") return openAddTag(ids);
      if (act === "enrich") return confirmAndRun("enrich", ids, "/api/bulk/enrich", { entity_ids: ids });
      if (act === "merge") return openMerge(ids);
      if (act === "export") return confirmAndExport(ids);
      if (act === "delete") return confirmAndRun("delete", ids, "/api/bulk/delete", { entity_ids: ids });
    });

    // ---------------- action handlers ----------------

    function openAssignRole(ids) {
      var rolesHtml = ROLES.map(function (r) { return '<option value="' + r + '">' + r + '</option>'; }).join("");
      openModal(
        '<h3 style="margin:0 0 12px">Assign role to ' + ids.length + ' selected</h3>' +
        '<label style="display:block;margin-bottom:8px">Role <select id="ads-bulk-role" style="width:100%;margin-top:4px">' + rolesHtml + '</select></label>' +
        '<label style="display:block;margin-bottom:12px"><input type="checkbox" id="ads-bulk-remove"> Remove this role instead</label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="ads-btn ads-btn--ghost" id="ads-bulk-cancel">Cancel</button>' +
        '<button class="ads-btn" id="ads-bulk-ok">Apply</button></div>'
      );
      document.getElementById("ads-bulk-cancel").onclick = closeModal;
      document.getElementById("ads-bulk-ok").onclick = function () {
        var role = document.getElementById("ads-bulk-role").value;
        var remove = document.getElementById("ads-bulk-remove").checked;
        closeModal();
        confirmAndRun("assign-role", ids, "/api/bulk/assign-role", { entity_ids: ids, role: role, remove: remove });
      };
    }
    function openAddTag(ids) {
      openModal(
        '<h3 style="margin:0 0 12px">Tag ' + ids.length + ' selected</h3>' +
        '<label style="display:block;margin-bottom:8px">Tag name <input id="ads-bulk-tagname" style="width:100%;margin-top:4px" placeholder="vc-2026"></label>' +
        '<label style="display:block;margin-bottom:12px">Taxonomy <select id="ads-bulk-tax" style="width:100%;margin-top:4px"><option value="tag">tag</option><option value="sector">sector</option><option value="stage">stage</option><option value="geo">geo</option><option value="role">role</option><option value="tech">tech</option></select></label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="ads-btn ads-btn--ghost" id="ads-bulk-cancel">Cancel</button>' +
        '<button class="ads-btn" id="ads-bulk-ok">Apply</button></div>'
      );
      document.getElementById("ads-bulk-cancel").onclick = closeModal;
      document.getElementById("ads-bulk-ok").onclick = function () {
        var name = document.getElementById("ads-bulk-tagname").value.trim();
        var tax = document.getElementById("ads-bulk-tax").value;
        if (!name) { return; }
        closeModal();
        confirmAndRun("add-tag", ids, "/api/bulk/add-tag", { entity_ids: ids, tag_name: name, taxonomy: tax });
      };
    }
    function openMerge(ids) {
      if (ids.length < 2) { toast("Select at least 2 entities to merge."); return; }
      openModal(
        '<h3 style="margin:0 0 12px">Merge ' + ids.length + ' selected</h3>' +
        '<label style="display:block;margin-bottom:8px">Canonical id (the row that survives) <select id="ads-bulk-canon" style="width:100%;margin-top:4px">' +
        ids.map(function (id) { return '<option value="' + esc(id) + '">' + esc(id) + '</option>'; }).join("") +
        '</select></label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="ads-btn ads-btn--ghost" id="ads-bulk-cancel">Cancel</button>' +
        '<button class="ads-btn" id="ads-bulk-ok">Merge</button></div>'
      );
      document.getElementById("ads-bulk-cancel").onclick = closeModal;
      document.getElementById("ads-bulk-ok").onclick = function () {
        var canon = document.getElementById("ads-bulk-canon").value;
        var merge = ids.filter(function (x) { return x !== canon; });
        closeModal();
        confirmAndRun("merge", merge, "/api/bulk/merge", { canonical_id: canon, merge_ids: merge });
      };
    }

    function confirmAndRun(action, ids, path, body) {
      var n = ids.length;
      var doIt = function (extraBody) {
        var idem = (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + "-" + Math.random()));
        api(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": idem },
          body: JSON.stringify(Object.assign({}, body, extraBody || {})),
        }).then(function (r) {
          showSuccessToast(action, r);
          selection.clear(); allMatchingMode = false; syncCheckboxes(); refreshBar();
        }).catch(function (e) {
          if (e.body && e.body.requires_confirmation) {
            promptConfirmation(action, e.body, function (extra) { doIt(extra); });
          } else {
            toast("Failed: " + esc(e.message));
          }
        });
      };
      if (n > 1000) {
        promptConfirmation(action, { requires_strict_confirmation: true, affected_count: n, sample: ids.slice(0, 5) },
          function (extra) { doIt(extra); });
      } else if (n > 100) {
        promptConfirmation(action, { requires_confirmation: true, affected_count: n, sample: ids.slice(0, 5) },
          function (extra) { doIt(extra); });
      } else {
        doIt();
      }
    }

    function promptConfirmation(action, info, cb) {
      var strict = info.requires_strict_confirmation === true;
      var sample = (info.sample || []).map(function (s) { return '<li><code>' + esc(s) + '</code></li>'; }).join("");
      openModal(
        '<h3 style="margin:0 0 8px">Confirm bulk ' + esc(action) + '</h3>' +
        '<p>This will affect <strong>' + esc(info.affected_count) + '</strong> entities.</p>' +
        '<p>Sample:</p><ul style="margin:0 0 12px;padding-left:18px">' + sample + '</ul>' +
        (strict ? '<label style="display:block;margin-bottom:12px">Type <code>CONFIRM</code> to proceed: <input id="ads-bulk-strict" style="width:100%;margin-top:4px"></label>' : '') +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="ads-btn ads-btn--ghost" id="ads-bulk-cancel">Cancel</button>' +
        '<button class="ads-btn" id="ads-bulk-ok">Proceed</button></div>'
      );
      document.getElementById("ads-bulk-cancel").onclick = closeModal;
      document.getElementById("ads-bulk-ok").onclick = function () {
        var extra = { confirmed: true };
        if (strict) {
          var token = document.getElementById("ads-bulk-strict").value.trim();
          if (token !== "CONFIRM") { return; }
          extra.confirmation_token = "CONFIRM";
        }
        closeModal();
        cb(extra);
      };
    }

    function showSuccessToast(action, r) {
      var opId = r && r.operation_id;
      var msg = '<strong>' + esc(action) + '</strong> ok · ' +
        esc(r && (r.affected != null ? r.affected : (r.dispatched != null ? r.dispatched : (r.results ? r.results.length : "")))) + ' affected' +
        (opId ? ' · <a href="#" data-undo="' + esc(opId) + '">Undo</a>' : '');
      var t = toast(msg, { ttl: 24000 });
      var undo = t.querySelector("a[data-undo]");
      if (undo) undo.addEventListener("click", function (e) {
        e.preventDefault();
        api("/api/bulk/undo/" + encodeURIComponent(opId), { method: "POST" })
          .then(function (u) { toast("Undone · reverted " + esc(u.reverted || 0) + " · conflicts " + esc(u.conflicts || 0)); })
          .catch(function (e) { toast("Undo failed: " + esc(e.message)); });
      });
    }

    // Route export through the same >100 / >1000 / CONFIRM
    // confirmation flow as every other bulk action.
    function confirmAndExport(ids) {
      var n = ids.length;
      var run = function (extra) { runExport(ids, extra || {}); };
      if (n > 1000) {
        promptConfirmation("export", { requires_strict_confirmation: true, affected_count: n, sample: ids.slice(0, 5) }, run);
      } else if (n > 100) {
        promptConfirmation("export", { requires_confirmation: true, affected_count: n, sample: ids.slice(0, 5) }, run);
      } else {
        run();
      }
    }
    function runExport(ids, extra) {
      var idem = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      var body = Object.assign({ entity_ids: ids }, extra || {});
      fetch(API + "/api/bulk/export", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idem },
        body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob().then(function (b) { return { blob: b, opId: r.headers.get("X-Operation-Id") }; });
      }).then(function (out) {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(out.blob);
        a.download = "bulk-export-" + String(out.opId || "").slice(0, 12) + ".csv";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        toast("Exported " + ids.length + " rows");
      }).catch(function (e) { toast("Export failed: " + esc(e.message)); });
    }

    // Persist on every selection mutation. We wrap the three call sites
    // (row check, page select, all-matching) so re-renders pick the same
    // ids back up.
    var _refreshBar = refreshBar;
    refreshBar = function () { persist(); _refreshBar(); };

    // Expose a `rebind` so pages can force resync after their own redraws
    // (e.g. after Apply Filters). Pages should also call `onFilterChange`
    // so the new filter signature is recorded and stale selection is
    // dropped if it no longer matches the visible result set.
    return {
      rebind: function () { bindRowChecks(); syncCheckboxes(); refreshBar(); },
      onFilterChange: function () {
        var sig = cfg.getFilterSignature ? cfg.getFilterSignature() : "";
        if (sig !== currentSignature) {
          currentSignature = sig;
          selection.clear();
          allMatchingMode = false;
          try { sessionStorage.removeItem(SIG_KEY); } catch (e) {}
          syncCheckboxes();
          refreshBar();
        }
      },
    };
  }

  window.adsBulkBar = { init: init };
})();
