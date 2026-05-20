// Task #5: incidents list + detail page.
(function () {
  var API = "https://api.aidatasignal.com/api/ops/system-health";

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmt(s) { return s ? new Date(s).toLocaleString() : "—"; }
  function ago(s) {
    if (!s) return "—";
    var ms = Date.now() - new Date(s).getTime();
    if (ms < 60000) return Math.round(ms / 1000) + "s ago";
    if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
    if (ms < 86400000) return Math.round(ms / 3600000) + "h ago";
    return Math.round(ms / 86400000) + "d ago";
  }

  async function api(path, opts) {
    var r = await fetch(API + path, Object.assign({ credentials: "include" }, opts || {}));
    if (r.status === 403) { showForbidden(); throw new Error("forbidden"); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function patch(path, body) {
    return api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  function showForbidden() {
    var chk = document.getElementById("ops-auth-check");
    if (chk) chk.hidden = true;
    var c = document.getElementById("ops-content");
    if (c) { c.hidden = true; c.innerHTML = ""; }
    var f = document.getElementById("ops-forbidden");
    if (f) f.hidden = false;
  }
  function reveal() {
    var chk = document.getElementById("ops-auth-check");
    if (chk) chk.hidden = true;
    var c = document.getElementById("ops-content");
    if (c) c.hidden = false;
  }

  function getId() {
    var qs = new URLSearchParams(location.search);
    return qs.get("id");
  }

  // ---- list mode ----
  async function loadList(status) {
    var tb = document.querySelector("#ops-incidents-table tbody");
    if (!tb) return;
    try {
      var data = await api("/incidents?status=" + encodeURIComponent(status || "all"));
      reveal();
      var rows = data.incidents || [];
      if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="ads-sub">No incidents.</td></tr>'; return; }
      tb.innerHTML = rows.map(function (r) {
        return '<tr>' +
          '<td class="ads-mono"><a href="/ops/incidents/?id=' + encodeURIComponent(r.id) + '">' + ago(r.opened_at) + '</a></td>' +
          '<td class="ads-mono">' + (r.closed_at ? ago(r.closed_at) : '<strong style="color:#c0392b">open</strong>') + '</td>' +
          '<td class="ads-mono">' + esc(r.severity) + '</td>' +
          '<td class="ads-mono">' + esc(r.kind) + '</td>' +
          '<td>' + esc(r.summary) + '</td>' +
          '<td class="ads-mono" style="max-width:14rem;overflow:hidden;text-overflow:ellipsis" title="' + esc(r.delivery_status || "") + '">' + esc(r.delivery_status || "—") + '</td>' +
          '</tr>';
      }).join("");
    } catch (e) {
      if ((e && e.message) !== "forbidden") {
        tb.innerHTML = '<tr><td colspan="6" class="ads-sub">Error: ' + esc(e.message) + '</td></tr>';
      }
    }
  }

  // ---- detail mode ----
  async function loadDetail(id) {
    try {
      var data = await api("/incidents/by-id?id=" + encodeURIComponent(id));
      reveal();
      var inc = data.incident || {};
      var meta = document.getElementById("ops-incident-meta");
      if (meta) {
        meta.innerHTML =
          '<div><strong>' + esc(inc.summary || "") + '</strong></div>' +
          '<div class="ads-mono" style="margin-top:.25rem;font-size:.9em;color:#6b7280">' +
          'id=' + esc(inc.id) + ' · kind=' + esc(inc.kind) + ' · severity=' + esc(inc.severity) +
          ' · signature=' + esc(inc.signature) +
          '</div>' +
          '<div class="ads-mono" style="margin-top:.25rem;font-size:.9em">' +
          'opened ' + fmt(inc.opened_at) + (inc.closed_at ? ' · closed ' + fmt(inc.closed_at) : ' · <strong style="color:#c0392b">OPEN</strong>') +
          (inc.acked_at ? ' · acked by ' + esc(inc.acked_by) + ' ' + fmt(inc.acked_at) : '') +
          '</div>' +
          (inc.delivery_status ? '<div class="ads-mono" style="margin-top:.25rem;font-size:.85em;color:#6b7280">delivery: ' + esc(inc.delivery_status) + '</div>' : '');
      }
      var ctxEl = document.getElementById("ops-incident-context");
      if (ctxEl) {
        try {
          var ctx = inc.context_json ? JSON.parse(inc.context_json) : null;
          ctxEl.textContent = ctx ? JSON.stringify(ctx, null, 2) : "(no context captured)";
        } catch (e) {
          ctxEl.textContent = inc.context_json || "(no context)";
        }
      }
      var tb = document.querySelector("#ops-incident-timeline tbody");
      if (tb) {
        var tl = data.timeline || [];
        if (!tl.length) { tb.innerHTML = '<tr><td colspan="4" class="ads-sub">No rollup snapshots in this window.</td></tr>'; }
        else {
          tb.innerHTML = tl.map(function (t) {
            return '<tr>' +
              '<td class="ads-mono">' + esc(t.bucket_start) + '</td>' +
              '<td class="ads-mono">' + esc(t.metric_name) + '</td>' +
              '<td class="ads-mono">' + (t.value == null ? "—" : t.value) + '</td>' +
              '<td class="ads-mono" style="max-width:20rem;overflow:hidden;text-overflow:ellipsis" title="' + esc(t.payload_json || "") + '">' + esc(t.payload_json || "") + '</td>' +
              '</tr>';
          }).join("");
        }
      }
      var notes = document.getElementById("ops-incident-notes");
      if (notes) notes.value = inc.resolution_notes || "";
    } catch (e) {
      if ((e && e.message) !== "forbidden") {
        var meta2 = document.getElementById("ops-incident-meta");
        if (meta2) meta2.innerHTML = '<div class="ads-sub">Error: ' + esc(e.message) + '</div>';
      }
    }
  }

  function setStatus(msg) {
    var el = document.getElementById("ops-incident-status");
    if (el) el.textContent = msg || "";
  }

  document.addEventListener("click", async function (ev) {
    var t = ev.target;
    if (!(t && t.tagName === "BUTTON")) return;
    var filter = t.getAttribute("data-filter");
    var action = t.getAttribute("data-action");
    if (filter) { loadList(filter); return; }
    var id = getId();
    if (!id || !action) return;
    try {
      if (action === "save-notes") {
        var notes = (document.getElementById("ops-incident-notes") || {}).value || "";
        await patch("/incidents/by-id?id=" + encodeURIComponent(id), { resolution_notes: notes });
        setStatus("saved");
      } else if (action === "ack") {
        await patch("/incidents/by-id?id=" + encodeURIComponent(id), { ack: true });
        setStatus("acknowledged");
        await loadDetail(id);
      } else if (action === "close") {
        if (!confirm("Mark this incident as closed?")) return;
        await patch("/incidents/by-id?id=" + encodeURIComponent(id), { close: true });
        setStatus("closed");
        await loadDetail(id);
      }
    } catch (e) {
      setStatus("error: " + (e && e.message));
    }
  });

  function start() {
    var id = getId();
    var listMode = document.getElementById("ops-incidents-list-mode");
    var detailMode = document.getElementById("ops-incident-detail-mode");
    if (id) {
      if (listMode) listMode.hidden = true;
      if (detailMode) detailMode.hidden = false;
      loadDetail(id);
    } else {
      if (listMode) listMode.hidden = false;
      if (detailMode) detailMode.hidden = true;
      loadList("all");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
