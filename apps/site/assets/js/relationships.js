// Task #4 (Relationship Inference Worker): Cytoscape-based Relationships
// explorer. Hydrates from:
//   GET /api/relationships/neighborhood?id=<entity_id>&hops=1
//   GET /api/relationships/paths?src=&dst=&max_hops=4
// Click-to-expand fetches the next hop and merges into the live graph.
(function () {
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function api(path) {
    if (window.adsApiFetch) return window.adsApiFetch(path);
    var base = (window.ADS && window.ADS.apiBase);
    return fetch(base + path, { credentials: "include" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
    });
  }

  // Per-kind colour + width contribution. Width is multiplied by quality_score.
  var KIND_COLOR = {
    works_at: "#3b82f6", worked_at: "#60a5fa", invested_in: "#10b981",
    co_invested_with: "#34d399", board_member_at: "#f59e0b",
    studied_at: "#a78bfa", school_with: "#c4b5fd",
    colleague_of: "#94a3b8", co_authored_with: "#ec4899",
    publicly_mentioned_with: "#94a3b8", portfolio_of: "#06b6d4",
    advises: "#f97316", family_of: "#ef4444",
  };
  function colourFor(kind) { return KIND_COLOR[kind] || "#9ca3af"; }
  function widthFor(quality) { return 1 + Math.max(0, Math.min(1, Number(quality) || 0)) * 4; }

  var cy = null;
  var rootId = null;
  function ensureGraph() {
    if (cy) return cy;
    cy = cytoscape({
      container: document.getElementById("ads-rel-cy"),
      style: [
        { selector: "node", style: {
            "background-color": "#1f2937", "label": "data(label)",
            "color": "#e5e7eb", "font-size": "10px",
            "text-valign": "bottom", "text-margin-y": 4,
            "border-color": "#4b5563", "border-width": 1, "width": 22, "height": 22,
          } },
        { selector: "node.root", style: { "background-color": "#2563eb", "border-color": "#60a5fa", "border-width": 2, "width": 32, "height": 32 } },
        { selector: "edge", style: {
            "width": "data(width)", "line-color": "data(colour)",
            "target-arrow-color": "data(colour)", "target-arrow-shape": "triangle",
            "curve-style": "bezier", "opacity": 0.85, "font-size": "9px", "color": "#9ca3af",
          } },
        { selector: "edge.path", style: { "line-color": "#fbbf24", "target-arrow-color": "#fbbf24", "width": 4, "opacity": 1 } },
        { selector: "node.path", style: { "border-color": "#fbbf24", "border-width": 3 } },
      ],
      layout: { name: "cose", animate: false },
    });
    cy.on("tap", "node", function (ev) { expand(ev.target.data("id")); });
    return cy;
  }

  function renderLegend() {
    var host = document.getElementById("ads-rel-legend");
    if (!host) return;
    host.innerHTML = Object.keys(KIND_COLOR).map(function (k) {
      return "<span><span style='display:inline-block;width:10px;height:10px;background:" + KIND_COLOR[k] + ";vertical-align:middle;margin-right:4px;border-radius:2px'></span>" + esc(k) + "</span>";
    }).join("");
  }

  function mergeGraph(payload, opts) {
    opts = opts || {};
    var g = ensureGraph();
    var addedNodes = [], addedEdges = [];
    (payload.nodes || []).forEach(function (n) {
      if (!g.getElementById(n.data.id).length) {
        addedNodes.push({ group: "nodes", data: n.data, classes: opts.rootId === n.data.id ? "root" : "" });
      }
    });
    (payload.edges || []).forEach(function (e) {
      if (!g.getElementById(e.data.id).length) {
        var d = Object.assign({}, e.data, {
          colour: colourFor(e.data.kind),
          width: widthFor(e.data.quality),
        });
        addedEdges.push({ group: "edges", data: d });
      }
    });
    g.add(addedNodes.concat(addedEdges));
    g.layout({ name: "cose", animate: false, fit: true, padding: 30 }).run();
  }

  function showNeighborhood(entityId) {
    rootId = entityId;
    if (cy) { cy.elements().remove(); }
    api("/api/relationships/neighborhood?id=" + encodeURIComponent(entityId) + "&hops=1&limit=150").then(function (j) {
      mergeGraph(j, { rootId: entityId });
      ensureGraph().getElementById(entityId).addClass("root");
    }).catch(function (e) {
      document.getElementById("ads-rel-cy").innerHTML = "<p style='padding:20px;color:#fca5a5'>Load failed: " + esc(e.message) + "</p>";
    });
  }

  function expand(entityId) {
    if (!entityId) return;
    api("/api/relationships/neighborhood?id=" + encodeURIComponent(entityId) + "&hops=1&limit=80").then(function (j) {
      mergeGraph(j, {});
    }).catch(function () { /* swallow expand errors */ });
  }

  function showPaths(srcId, dstId) {
    var pathsHost = document.getElementById("ads-rel-paths");
    pathsHost.innerHTML = "<p style='color:#888'>Finding paths…</p>";
    api("/api/relationships/paths?src=" + encodeURIComponent(srcId) + "&dst=" + encodeURIComponent(dstId) + "&max_hops=4&k=5").then(function (j) {
      var paths = j.paths || [];
      if (!paths.length) {
        pathsHost.innerHTML = "<p style='color:#fca5a5'>No path found within 4 hops.</p>";
        return;
      }
      var nodeMeta = {};
      (j.nodes || []).forEach(function (n) { nodeMeta[n.id] = n; });
      function nameFor(id) { return (nodeMeta[id] && nodeMeta[id].display_name) || id.slice(0, 8); }
      pathsHost.innerHTML = "<h3 style='font-size:14px;margin:8px 0'>Found " + paths.length + " path" + (paths.length === 1 ? "" : "s") + "</h3>" +
        paths.map(function (p, ix) {
          var pieces = [];
          for (var i = 0; i < p.nodes.length; i++) {
            pieces.push("<span class='ads-rel-path-chip'>" + esc(nameFor(p.nodes[i])) + "</span>");
            if (i < p.edges.length) {
              pieces.push("<span class='ads-rel-path-edge'>—" + esc(p.edges[i].kind) + "→</span>");
            }
          }
          return "<div class='ads-rel-path-row'><strong>Path " + (ix + 1) + "</strong> (" + p.hops + " hop" + (p.hops === 1 ? "" : "s") + ", Σq=" + p.total_quality.toFixed(2) + "): " + pieces.join("") + "</div>";
        }).join("");
      // Highlight the shortest path in the live graph.
      ensureGraph().elements().removeClass("path");
      paths[0].edges.forEach(function (step) {
        var cyg = ensureGraph();
        cyg.getElementById(step.src).addClass("path");
        cyg.getElementById(step.dst).addClass("path");
        cyg.edges().forEach(function (e) {
          var d = e.data();
          if ((d.source === step.src && d.target === step.dst) || (d.source === step.dst && d.target === step.src)) e.addClass("path");
        });
      });
    }).catch(function (e) {
      pathsHost.innerHTML = "<p style='color:#fca5a5'>Path lookup failed: " + esc(e.message) + "</p>";
    });
  }

  function attachSearch(input, popup, onPick) {
    var t = null;
    input.addEventListener("input", function () {
      clearTimeout(t);
      var q = input.value.trim();
      if (q.length < 2) { popup.hidden = true; popup.innerHTML = ""; return; }
      t = setTimeout(function () {
        // Constrain to entity-only results: rel_edges holds person/org
        // u_entities ids, so personas/projects/views shouldn't appear.
        // /api/search returns { items: [{ id, type, title, subtitle, kind }] }.
        Promise.all([
          api("/api/search?q=" + encodeURIComponent(q) + "&type=person&limit=10"),
          api("/api/search?q=" + encodeURIComponent(q) + "&type=org&limit=10"),
        ]).then(function (rs) {
          var items = ((rs[0] && rs[0].items) || []).concat((rs[1] && rs[1].items) || []);
          items.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
          items = items.slice(0, 10);
          if (!items.length) { popup.innerHTML = "<button disabled style='color:#999'>No matches</button>"; }
          else {
            popup.innerHTML = items.map(function (it) {
              var id = it.id;
              var name = it.title || id;
              var sub = it.subtitle || it.type || "";
              return "<button data-id='" + esc(id) + "' data-name='" + esc(name) + "'>" +
                "<strong>" + esc(name) + "</strong>" +
                (sub ? " <span style='color:#888'>· " + esc(sub) + "</span>" : "") +
                "</button>";
            }).join("");
          }
          popup.hidden = false;
        }).catch(function () { popup.hidden = true; });
      }, 180);
    });
    popup.addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-id]");
      if (!b) return;
      input.value = b.dataset.name;
      input.dataset.entityId = b.dataset.id;
      popup.hidden = true;
      onPick(b.dataset.id, b.dataset.name);
    });
    document.addEventListener("click", function (ev) {
      if (!popup.contains(ev.target) && ev.target !== input) popup.hidden = true;
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    renderLegend();
    var fromInput = document.getElementById("ads-rel-from");
    var toInput = document.getElementById("ads-rel-to");
    var fromPop = document.getElementById("ads-rel-from-results");
    var toPop = document.getElementById("ads-rel-to-results");
    var go = document.getElementById("ads-rel-go");
    if (!fromInput) return;

    attachSearch(fromInput, fromPop, function (id) { if (!toInput.dataset.entityId) showNeighborhood(id); });
    attachSearch(toInput, toPop, function () {});
    go.addEventListener("click", function () {
      var srcId = fromInput.dataset.entityId;
      var dstId = toInput.dataset.entityId;
      if (!srcId) { alert("Pick a 'from' entity first."); return; }
      if (dstId) {
        showNeighborhood(srcId);
        setTimeout(function () { showPaths(srcId, dstId); }, 250);
      } else {
        showNeighborhood(srcId);
      }
    });

    // Honour ?id= query string for deep-links per the Task #4 static-routing constraint.
    var qs = new URLSearchParams(location.search);
    var preId = qs.get("id");
    if (preId) showNeighborhood(preId);
  });
})();
