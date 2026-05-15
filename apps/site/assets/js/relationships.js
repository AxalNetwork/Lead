// Global relationships explorer page (Task #21).
(function () {
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  async function api(path) {
    if (window.adsApiFetch) return window.adsApiFetch(path);
    var base = (window.ADS && window.ADS.apiBase) || "https://api.aidatasignal.com";
    return fetch(base + path, { credentials: "include" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  function attachSearch(input, popup, onPick) {
    var t = null;
    input.addEventListener("input", function () {
      clearTimeout(t);
      var q = input.value.trim();
      if (q.length < 2) { popup.hidden = true; popup.innerHTML = ""; return; }
      t = setTimeout(function () {
        api("/api/relationships/search?q=" + encodeURIComponent(q)).then(function (j) {
          var items = j.items || [];
          if (!items.length) { popup.innerHTML = "<button disabled style='color:#999'>No matches</button>"; }
          else {
            popup.innerHTML = items.map(function (it) {
              return "<button data-id='" + it.id + "' data-name='" + esc(it.name) + "'>" +
                "<strong>" + esc(it.name) + "</strong> <span style='color:#888'>· " + esc(it.kind) + "</span></button>";
            }).join("");
          }
          popup.hidden = false;
        });
      }, 180);
    });
    popup.addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-id]");
      if (!b) return;
      input.value = b.dataset.name;
      input.dataset.entityId = b.dataset.id;
      popup.hidden = true;
      onPick(Number(b.dataset.id), b.dataset.name);
    });
    document.addEventListener("click", function (ev) {
      if (!popup.contains(ev.target) && ev.target !== input) popup.hidden = true;
    });
  }

  var fromInput = document.getElementById("ads-rel-from");
  var toInput = document.getElementById("ads-rel-to");
  var fromPop = document.getElementById("ads-rel-from-results");
  var toPop = document.getElementById("ads-rel-to-results");
  var go = document.getElementById("ads-rel-go");
  var graphHost = document.getElementById("ads-rel-graph");

  function showSubgraph(entityId) {
    graphHost.innerHTML = "";
    window.ADSRelGraph.mount(graphHost, { entityId: entityId, depth: 1, limit: 120, height: 560 });
  }

  function showPath(srcId, dstId) {
    graphHost.innerHTML = "<div class='ads-loading'>Finding shortest path…</div>";
    api("/api/relationships/path?src=" + srcId + "&dst=" + dstId + "&max_hops=4").then(function (j) {
      if (!j.nodes || !j.nodes.length || j.hops < 0) {
        graphHost.innerHTML = "<p class='ads-empty'>No path found within 4 hops.</p>";
        return;
      }
      graphHost.innerHTML =
        "<div style='margin-bottom:8px;font-size:13px'><strong>" + j.hops + "-hop path</strong>: " +
        j.nodes.map(function (n) { return "<span style='padding:2px 6px;border-radius:3px;background:#eef'>" + esc(n.name) + "</span>"; }).join(" → ") +
        "</div><div id='ads-rel-pathgraph'></div>";
      var host = document.getElementById("ads-rel-pathgraph");
      // Render the path using the ForceGraph directly so we don't BFS again.
      host.innerHTML = "<canvas style='width:100%;height:420px;display:block;border:1px solid #e5e5ea;border-radius:6px;background:#fff'></canvas>";
      var canvas = host.querySelector("canvas");
      var nodes = j.nodes.map(function (n) { return { id: n.id, label: n.name, kind: n.kind, ref: n }; });
      var edges = j.edges.map(function (e) { return { src: e.src, dst: e.dst, kind: e.kind, ref: e }; });
      window.ADSForceGraph(canvas, { nodes: nodes, edges: edges }, { anchorId: srcId });
    }).catch(function (e) {
      graphHost.innerHTML = "<p class='ads-empty'>Path lookup failed: " + esc(e.message) + "</p>";
    });
  }

  attachSearch(fromInput, fromPop, function (id) { if (!toInput.dataset.entityId) showSubgraph(id); });
  attachSearch(toInput, toPop, function () {});

  go.addEventListener("click", function () {
    var srcId = Number(fromInput.dataset.entityId);
    var dstId = Number(toInput.dataset.entityId);
    if (!Number.isFinite(srcId)) { alert("Pick a 'from' entity first."); return; }
    if (Number.isFinite(dstId)) showPath(srcId, dstId);
    else showSubgraph(srcId);
  });
})();
