/* Reusable relationship-graph component.
 *
 * window.ADSRelGraph.mount(container, { entityId, kinds?, depth?, limit?, onSelect? })
 *
 * - Loads /api/relationships/entity/{id} via window.adsApiFetch
 * - Renders a canvas via window.ADSForceGraph and a sidebar with details/legend
 * - Click any node to deep-link: leads -> /dashboard/lead/?id=…, firms -> /dashboard/firms/detail/?id=…
 */
(function () {
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function deepLinkFor(entity) {
    if (!entity || !entity.ref_table || !entity.ref_id) return null;
    if (entity.ref_table === "leads") return "/dashboard/lead/?id=" + encodeURIComponent(entity.ref_id);
    if (entity.ref_table === "firms") return "/dashboard/firms/detail/?id=" + encodeURIComponent(entity.ref_id);
    return null;
  }

  async function api(path) {
    if (window.adsApiFetch) return window.adsApiFetch(path);
    var base = (window.ADS && window.ADS.apiBase) || "https://api.aidatasignal.com";
    return fetch(base + path, { credentials: "include" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  var KINDS = [
    "works_at", "was_at", "partner_at", "founded",
    "invested_in", "led_round_in", "co_invested_with",
    "board_of", "school_with", "colleague_of",
    "family_of", "referred", "mentions",
  ];

  function legendHtml(activeKinds) {
    var dots = ["person", "firm", "company", "school"].map(function (k) {
      return '<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + window.ADSForceGraph.colorForKind(k) + '"></span>' + k + "</span>";
    }).join("");
    var checks = KINDS.map(function (k) {
      var on = !activeKinds || activeKinds.indexOf(k) !== -1;
      return '<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 8px 2px 0;font-size:11px"><input type="checkbox" data-kind="' + k + '" ' + (on ? "checked" : "") + '><span style="display:inline-block;width:8px;height:8px;background:' + window.ADSForceGraph.edgeColor(k) + '"></span>' + k + "</label>";
    }).join("");
    return "<div style='margin-bottom:6px'>" + dots + "</div><div>" + checks + "</div>";
  }

  function mount(container, opts) {
    opts = opts || {};
    var entityId = opts.entityId;
    if (entityId == null) { container.textContent = "Missing entityId"; return; }
    var depth = opts.depth || 1;
    var limit = opts.limit || 100;
    var activeKinds = opts.kinds ? opts.kinds.slice() : null;

    container.innerHTML =
      "<div style='display:grid;grid-template-columns:1fr 260px;gap:8px;align-items:stretch'>" +
        "<div style='display:flex;flex-direction:column;gap:6px'>" +
          "<div data-rel='legend' style='font-size:12px;color:#444'></div>" +
          "<div style='position:relative;border:1px solid #e5e5ea;border-radius:6px;height:" + (opts.height || 480) + "px;background:#fff;overflow:hidden'>" +
            "<canvas data-rel='canvas' style='position:absolute;inset:0;width:100%;height:100%'></canvas>" +
            "<div data-rel='loading' style='position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888;font-size:12px'>Loading graph…</div>" +
          "</div>" +
        "</div>" +
        "<aside data-rel='side' style='border:1px solid #e5e5ea;border-radius:6px;padding:10px;font-size:12px;background:#fff;min-height:120px'>" +
          "<p class='ads-muted' style='margin:0'>Click a node for details. Drag to reposition. Scroll to zoom.</p>" +
        "</aside>" +
      "</div>";

    var canvas = container.querySelector("[data-rel='canvas']");
    var legend = container.querySelector("[data-rel='legend']");
    var loading = container.querySelector("[data-rel='loading']");
    var side = container.querySelector("[data-rel='side']");
    legend.innerHTML = legendHtml(activeKinds);

    legend.addEventListener("change", function () {
      activeKinds = Array.prototype.map.call(legend.querySelectorAll("input:checked"), function (i) { return i.dataset.kind; });
      load();
    });

    var graph = null;
    var expanded = {}; // entityId -> true for nodes already expanded once
    var clickBound = false;
    function load() {
      loading.hidden = false;
      var qs = "?depth=" + depth + "&limit=" + limit
        + (activeKinds && activeKinds.length ? "&kinds=" + encodeURIComponent(activeKinds.join(",")) : "")
        + (opts.includeFamily ? "&include_family=1" : "");
      api("/api/relationships/entity/" + encodeURIComponent(entityId) + qs).then(function (j) {
        loading.hidden = true;
        // Flatten ref_table/ref_id onto the node so initial click payloads
        // match expand/collapse payloads (deeplinks need them at top level).
        var nodes = (j.nodes || []).map(function (n) { return { id: n.id, label: n.name, name: n.name, kind: n.kind, ref_table: n.ref_table, ref_id: n.ref_id, ref: n }; });
        var edges = (j.edges || []).map(function (e) { return { src: e.src, dst: e.dst, kind: e.kind, strength: e.strength, ref: e }; });
        if (graph) graph.stop();
        graph = window.ADSForceGraph(canvas, { nodes: nodes, edges: edges }, { anchorId: entityId, height: opts.height });
        if (clickBound) return; clickBound = true;
        canvas.addEventListener("node:click", function (ev) {
          var n = ev.detail;
          var link = deepLinkFor(n);
          var expandLabel = expanded[n.id] ? "Collapse" : "Expand";
          var html = "<h4 style='margin:0 0 6px;font-size:13px'>" + esc(n.name) + "</h4>" +
            "<div class='ads-muted' style='margin-bottom:6px'>" + esc(n.kind) + (n.ref_table ? " · " + esc(n.ref_table) + "#" + esc(n.ref_id) : "") + "</div>" +
            "<button class='ads-btn ads-btn--ghost' data-act='toggle' data-id='" + n.id + "' style='margin-right:6px'>" + expandLabel + "</button>";
          if (link) html += "<a href='" + link + "'>Open detail →</a>";
          if (opts.onSelect) opts.onSelect(n);
          side.innerHTML = html;
        });
        canvas.addEventListener("node:dblclick", function (ev) { expandNode(ev.detail.id); });
        side.addEventListener("click", function (ev) {
          var b = ev.target.closest("button[data-act='toggle']");
          if (!b) return;
          var nid = Number(b.dataset.id);
          if (expanded[nid]) collapseNode(nid); else expandNode(nid);
          // Refresh the sidebar label after toggling.
          b.textContent = expanded[nid] ? "Collapse" : "Expand";
        });
      }).catch(function (e) {
        loading.hidden = true;
        side.innerHTML = "<p class='ads-muted'>Failed to load: " + esc(e.message) + "</p>";
      });
    }
    function expandNode(id) {
      if (!graph || expanded[id]) return;
      var qs = "?depth=1&limit=80"
        + (activeKinds && activeKinds.length ? "&kinds=" + encodeURIComponent(activeKinds.join(",")) : "")
        + (opts.includeFamily ? "&include_family=1" : "");
      api("/api/relationships/entity/" + encodeURIComponent(id) + qs).then(function (j) {
        graph.addData({
          nodes: (j.nodes || []).map(function (n) { return { id: n.id, label: n.name, name: n.name, kind: n.kind, ref_table: n.ref_table, ref_id: n.ref_id }; }),
          edges: (j.edges || []).map(function (e) { return { src: e.src, dst: e.dst, kind: e.kind, strength: e.strength }; }),
        });
        expanded[id] = (j.nodes || []).map(function (n) { return n.id; }).filter(function (nid) { return nid !== id && nid !== entityId; });
      });
    }
    function collapseNode(id) {
      if (!graph || !expanded[id] || !Array.isArray(expanded[id])) return;
      // Only collapse nodes that aren't reachable from the anchor by some
      // other path; for simplicity we just remove the nodes added during
      // this expansion that aren't shared with other expansions.
      var keep = {};
      Object.keys(expanded).forEach(function (k) {
        if (Number(k) === id || !Array.isArray(expanded[k])) return;
        expanded[k].forEach(function (nid) { keep[nid] = true; });
      });
      var rm = expanded[id].filter(function (nid) { return !keep[nid]; });
      graph.removeNodes(rm);
      expanded[id] = false;
    }
    load();
    return { reload: load, expand: expandNode, collapse: collapseNode };
  }

  window.ADSRelGraph = { mount: mount };
})();
