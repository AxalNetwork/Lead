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
    var base = (window.ADS && window.ADS.apiBase);
    return window.adsUtil.request(base + path, { credentials: "include" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
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
    // Task #3 — Edge-Quality Scoring + Power-Node Detection.
    // The legacy /api/relationships/entity/:id endpoint speaks the
    // INTEGER-id graph; the new /api/entities/:id/* endpoints speak
    // the unified TEXT-id graph (rel_edges). We bridge the two via
    // POST /api/entities/resolve which maps each legacy node's
    // (ref_table, ref_id) → unified_entity_id. Once we have that
    // mapping the overlays key off STABLE IDs (not display names),
    // and every existing callsite auto-activates the overlay without
    // having to pass `unifiedEntityId` explicitly. The opt-in
    // `unifiedEntityId` param is still respected if the caller
    // already knows it.
    var influenceSummary = null;
    var qualityByLegacyEdge = {};       // "src|dst|kind" → quality_score (legacy ids)
    var powerSetUnifiedIds = {};        // unified_id → true
    var unifiedIdByLegacyNodeId = {};   // legacy node id → unified id
    var anchorUnifiedId = opts.unifiedEntityId || null;

    function resolveUnifiedIds(legacyNodes) {
      // Bulk-resolve all (ref_table, ref_id) → unified id.
      var refs = [];
      var keys = [];
      legacyNodes.forEach(function (n) {
        if (n.ref_table && n.ref_id != null) {
          refs.push({ ref_table: n.ref_table, ref_id: n.ref_id });
          keys.push({ node_id: n.id, key: n.ref_table + ":" + n.ref_id });
        }
      });
      unifiedIdByLegacyNodeId = {};
      if (!refs.length) return Promise.resolve({});
      return apiPost("/api/entities/resolve", { refs: refs })
        .then(function (j) {
          var m = (j && j.map) || {};
          keys.forEach(function (k) {
            if (m[k.key]) unifiedIdByLegacyNodeId[k.node_id] = m[k.key];
          });
          if (!anchorUnifiedId && unifiedIdByLegacyNodeId[entityId]) {
            anchorUnifiedId = unifiedIdByLegacyNodeId[entityId];
          }
          return m;
        })
        .catch(function () { return {}; });
    }
    function loadInfluence() {
      if (!anchorUnifiedId) return Promise.resolve(null);
      return api("/api/entities/" + encodeURIComponent(anchorUnifiedId) + "/influence")
        .then(function (j) { influenceSummary = j; return j; })
        .catch(function () { influenceSummary = null; return null; });
    }
    function loadAnchorUnifiedRelationships() {
      if (!anchorUnifiedId) return Promise.resolve(null);
      return api("/api/entities/" + encodeURIComponent(anchorUnifiedId) + "/relationships?limit=500")
        .then(function (j) {
          // Build a unified-id → quality lookup keyed by
          // (neighbor_unified_id, kind). The legacy edge mapping is
          // then done by looking up each legacy edge's neighbor's
          // unified id via unifiedIdByLegacyNodeId.
          var rows = (j && j.edges) || [];
          var byNeighbor = {};
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var nbr = r.neighbor_id;
            if (!nbr) continue;
            var key = nbr + "|" + (r.kind || "").toLowerCase().trim();
            var prev = byNeighbor[key];
            if (prev == null || (r.quality_score || 0) > prev) {
              byNeighbor[key] = r.quality_score != null ? r.quality_score : null;
            }
          }
          // Stash on the closure for the edge-mapping pass below.
          loadAnchorUnifiedRelationships._byNeighbor = byNeighbor;
          return j;
        })
        .catch(function () { loadAnchorUnifiedRelationships._byNeighbor = {}; return null; });
    }
    function loadPowerNodes() {
      // Pull the global power-node set so any node in the subgraph
      // whose unified id is flagged can glow. Match by stable id.
      return api("/api/power-nodes?limit=500")
        .then(function (j) {
          powerSetUnifiedIds = {};
          var rows = (j && j.power_nodes) || [];
          for (var i = 0; i < rows.length; i++) {
            if (rows[i].entity_id) powerSetUnifiedIds[rows[i].entity_id] = true;
          }
          return j;
        })
        .catch(function () { powerSetUnifiedIds = {}; return null; });
    }

    function apiPost(path, body) {
      if (window.adsApiFetch) return window.adsApiFetch(path, { method: "POST", body: JSON.stringify(body) });
      var base = (window.ADS && window.ADS.apiBase);
      return window.adsUtil.request(base + path, { method: "POST", body: JSON.stringify(body), credentials: "include" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
    }
    function influenceHtml() {
      if (!influenceSummary) return "";
      var i = influenceSummary;
      if (i.pagerank_score == null) return "";
      var glow = i.is_power_node
        ? "<span style='display:inline-block;padding:2px 6px;border-radius:10px;background:radial-gradient(circle,#fde68a,#f59e0b);color:#000;font-weight:600;font-size:10px;box-shadow:0 0 8px #f59e0b'>POWER NODE</span> "
        : "";
      var pr = (i.pagerank_score || 0).toFixed(4);
      var br = (i.broker_score || 0).toFixed(3);
      var deg = (i.in_degree || 0) + "/" + (i.out_degree || 0);
      var sector = i.primary_sector ? esc(i.primary_sector) : "—";
      return "<div style='margin-top:8px;padding:8px;border:1px solid #e5e5ea;border-radius:6px;background:#fafafa'>" +
        glow +
        "<div style='font-size:10px;color:#666;margin-bottom:4px'>INFLUENCE</div>" +
        "<div>PageRank: <b>" + pr + "</b></div>" +
        "<div>Broker: <b>" + br + "</b></div>" +
        "<div>In/Out degree: <b>" + deg + "</b></div>" +
        "<div>Primary sector: <b>" + sector + "</b></div>" +
        "</div>";
    }
    function load() {
      loading.hidden = false;
      var qs = "?depth=" + depth + "&limit=" + limit
        + (activeKinds && activeKinds.length ? "&kinds=" + encodeURIComponent(activeKinds.join(",")) : "")
        + (opts.includeFamily ? "&include_family=1" : "");
      // Step 1: load legacy graph + global power-node set in parallel.
      // Step 2: resolve all legacy nodes' (ref_table, ref_id) →
      // unified ids in one bulk call.
      // Step 3: with the mapping in hand, fetch anchor influence +
      // anchor unified relationships (which need the unified id).
      // Step 4: render with overlays keyed by stable ids.
      api("/api/relationships/entity/" + encodeURIComponent(entityId) + qs)
        .then(function (j) {
          return Promise.all([
            j,
            resolveUnifiedIds(j.nodes || []),
            loadPowerNodes(),
          ]);
        })
        .then(function (step2) {
          var j = step2[0];
          return Promise.all([
            j,
            loadInfluence(),
            loadAnchorUnifiedRelationships(),
          ]);
        })
        .then(function (results) {
        var j = results[0];
        loading.hidden = true;
        var anchorIsPower = !!(influenceSummary && influenceSummary.is_power_node);
        var byNeighbor = loadAnchorUnifiedRelationships._byNeighbor || {};
        // Flatten ref_table/ref_id onto the node so initial click payloads
        // match expand/collapse payloads (deeplinks need them at top level).
        var nodes = (j.nodes || []).map(function (n) {
          var unifiedId = unifiedIdByLegacyNodeId[n.id];
          var isPower = (n.id === entityId && anchorIsPower) || (unifiedId && !!powerSetUnifiedIds[unifiedId]);
          return { id: n.id, label: n.name, name: n.name, kind: n.kind, ref_table: n.ref_table, ref_id: n.ref_id, is_power_node: !!isPower, ref: n };
        });
        var edges = (j.edges || []).map(function (e) {
          // For edges incident to the anchor we know the neighbor's
          // legacy id and can map it to a unified id, then look up
          // quality_score by (neighbor_unified_id, kind).
          var quality = null;
          var nbrLegacyId = (e.src === entityId) ? e.dst : ((e.dst === entityId) ? e.src : null);
          if (nbrLegacyId != null) {
            var nbrUnifiedId = unifiedIdByLegacyNodeId[nbrLegacyId];
            if (nbrUnifiedId) {
              var key = nbrUnifiedId + "|" + (e.kind || "").toLowerCase().trim();
              var q = byNeighbor[key];
              if (typeof q === "number") quality = q;
            }
          }
          return { src: e.src, dst: e.dst, kind: e.kind, strength: e.strength, quality_score: quality, ref: e };
        });
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
          // Show influence summary for the anchor entity (Task #3).
          if (n.id === entityId) html += influenceHtml();
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
        return resolveUnifiedIds(j.nodes || []).then(function () { return j; });
      }).then(function (j) {
        graph.addData({
          nodes: (j.nodes || []).map(function (n) {
            var unifiedId = unifiedIdByLegacyNodeId[n.id];
            return { id: n.id, label: n.name, name: n.name, kind: n.kind, ref_table: n.ref_table, ref_id: n.ref_id, is_power_node: !!(unifiedId && powerSetUnifiedIds[unifiedId]) };
          }),
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
