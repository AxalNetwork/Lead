// Task #1: Garbage Entity Review console — front-end.
// Pre-flights GET /api/ops/garbage-review/ (admin-only on worker) and
// reveals content only on 2xx. List paginates via offset; Restore /
// Permanently Delete post to the worker.
(function () {
  var API = "https://api.aidatasignal.com/api/ops/garbage-review";
  var state = { offset: 0, limit: 50, q: "", nextOffset: null };

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmt(s) { return s ? new Date(s).toLocaleString() : "—"; }

  async function api(path, opts) {
    var r = await fetch(API + path, Object.assign({ credentials: "include" }, opts || {}));
    if (r.status === 403) { showForbidden(); throw new Error("forbidden"); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function post(path) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  }

  function showForbidden() {
    var chk = document.getElementById("ops-auth-check");
    if (chk) chk.hidden = true;
    var content = document.getElementById("ops-content");
    if (content) { content.hidden = true; content.innerHTML = ""; }
    var f = document.getElementById("ops-forbidden");
    if (f) f.hidden = false;
  }
  function revealContent() {
    var chk = document.getElementById("ops-auth-check");
    if (chk) chk.hidden = true;
    var content = document.getElementById("ops-content");
    if (content) content.hidden = false;
  }

  async function loadIndex() {
    var r = await api("/");
    $("#g-total").textContent = String(r.soft_deleted_total || 0);
    $("#g-24h").textContent = String(r.soft_deleted_last_24h || 0);
    $("#g-log").textContent = String(r.audit_log_rows || 0);
  }

  function parseReason(raw) {
    if (!raw) return "—";
    // soft-delete reason format: "garbage_detector_v1:reason1,reason2"
    var m = String(raw).split(":");
    if (m.length >= 2) return m.slice(1).join(":");
    return raw;
  }

  async function loadList() {
    var tbody = document.querySelector("#g-table tbody");
    tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
    var qs = "?limit=" + state.limit + "&offset=" + state.offset;
    if (state.q) qs += "&q=" + encodeURIComponent(state.q);
    var r = await api("/list" + qs);
    var items = r.items || [];
    state.nextOffset = r.nextOffset;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="ads-empty">No soft-deleted entities.</td></tr>';
    } else {
      tbody.innerHTML = items.map(function (e) {
        var deepLink = "/dashboard/profile/?id=" + encodeURIComponent(e.id);
        var url = e.primary_url || (e.primary_domain ? ("https://" + e.primary_domain) : null);
        return "<tr>"
          + "<td><code>" + esc(e.kind) + "</code></td>"
          + "<td><a href=\"" + esc(deepLink) + "\">" + esc(e.display_name || "(empty)") + "</a></td>"
          + "<td>" + (url ? "<a href=\"" + esc(url) + "\" target=\"_blank\" rel=\"noopener\"><code class=\"ads-mono\" style=\"word-break:break-all\">" + esc(url) + "</code></a>" : "—") + "</td>"
          + "<td><code class=\"ads-mono\" style=\"font-size:.8em\">" + esc(parseReason(e.deleted_reason)) + "</code></td>"
          + "<td>" + esc(fmt(e.updated_at)) + "</td>"
          + "<td>"
          + "<button class=\"ads-btn\" data-restore=\"" + esc(e.id) + "\">Restore</button> "
          + "<button class=\"ads-btn ads-btn--err\" data-purge=\"" + esc(e.id) + "\">Permanently delete</button>"
          + "</td></tr>";
      }).join("");
    }
    $("#g-prev").disabled = state.offset <= 0;
    $("#g-next").disabled = state.nextOffset == null;
  }

  async function refreshAll() {
    try {
      await loadIndex();
      await loadList();
    } catch (e) { /* forbidden path handled by api() */ }
  }

  document.addEventListener("click", async function (ev) {
    var t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    var restoreId = t.getAttribute("data-restore");
    var purgeId = t.getAttribute("data-purge");
    if (restoreId) {
      if (!confirm("Restore this entity to active status?")) return;
      t.disabled = true;
      try { await post("/" + encodeURIComponent(restoreId) + "/restore"); }
      catch (e) { alert("Restore failed: " + e.message); t.disabled = false; return; }
      await refreshAll();
    } else if (purgeId) {
      if (!confirm("PERMANENTLY DELETE this entity and all its facts/relationships/channels? This cannot be undone.")) return;
      t.disabled = true;
      try { await post("/" + encodeURIComponent(purgeId) + "/purge"); }
      catch (e) { alert("Purge failed: " + e.message); t.disabled = false; return; }
      await refreshAll();
    }
  });

  async function init() {
    try {
      await loadIndex();
      revealContent();
      await loadList();
    } catch (e) {
      // 403 already surfaced by showForbidden; ignore.
    }

    var qInput = $("#g-q");
    if (qInput) {
      var timer = null;
      qInput.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          state.q = qInput.value.trim();
          state.offset = 0;
          loadList().catch(function () {});
        }, 300);
      });
    }
    $("#g-refresh").addEventListener("click", function () { refreshAll(); });
    $("#g-prev").addEventListener("click", function () {
      state.offset = Math.max(0, state.offset - state.limit);
      loadList().catch(function () {});
    });
    $("#g-next").addEventListener("click", function () {
      if (state.nextOffset != null) {
        state.offset = state.nextOffset;
        loadList().catch(function () {});
      }
    });
    $("#g-sweep-recent").addEventListener("click", async function () {
      if (!confirm("Run the garbage detector against entities created in the last 6h?")) return;
      $("#g-sweep-status").textContent = "Running recent sweep…";
      try {
        var r = await post("/cleanup-now?mode=recent&lookback_hours=6");
        $("#g-sweep-status").textContent = "Sweep done: scanned=" + r.scanned + ", flagged=" + r.flagged + ", soft_deleted=" + r.soft_deleted;
        await refreshAll();
      } catch (e) {
        $("#g-sweep-status").textContent = "Sweep failed: " + e.message;
      }
    });
    $("#g-sweep-all").addEventListener("click", async function () {
      if (!confirm("Run the FULL one-off cleanup pass over every active entity? Bounded at 5000.")) return;
      $("#g-sweep-status").textContent = "Running full cleanup…";
      try {
        var r = await post("/cleanup-now?mode=all&limit=5000");
        $("#g-sweep-status").textContent = "Full sweep done: scanned=" + r.scanned + ", flagged=" + r.flagged + ", soft_deleted=" + r.soft_deleted + (r.bounded ? " (BOUNDED — re-run to continue)" : "");
        await refreshAll();
      } catch (e) {
        $("#g-sweep-status").textContent = "Sweep failed: " + e.message;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
