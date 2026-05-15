/* Tiny canvas force-directed graph (~6KB).
 * Hand-rolled to keep the dashboard bundle small and avoid third-party
 * dependencies. O(N²) repulsion is fine for the spec'd ≤200 nodes per
 * subgraph. API: window.ADSForceGraph(canvas, { nodes, edges, opts? }).
 *
 * nodes: [{ id, label, kind?, color?, r? }]
 * edges: [{ src, dst, kind?, color?, label? }]
 *
 * Returns: { stop(), zoomTo(id), getNodeAt(x,y), redraw() }
 *  - emits 'node:click' (node) and 'node:hover' (node|null) DOM events on the canvas
 */
(function () {
  function rgb(s) { return s || "#888"; }
  function colorForKind(kind) {
    switch (kind) {
      case "person": return "#3a7";
      case "firm": return "#37a";
      case "company": return "#a73";
      case "school": return "#a37";
      case "user": return "#000";
      default: return "#888";
    }
  }
  function edgeColor(kind) {
    switch (kind) {
      case "works_at": case "partner_at": return "#37a";
      case "was_at": return "#aab";
      case "invested_in": case "led_round_in": return "#a73";
      case "co_invested_with": return "#cb6";
      case "founded": return "#a37";
      case "school_with": return "#37a8";
      case "colleague_of": return "#3a7";
      case "family_of": return "#c33";
      case "referred": return "#737";
      case "mentions": return "#bbb";
      default: return "#999";
    }
  }

  function ForceGraph(canvas, data, opts) {
    opts = opts || {};
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    function fitCanvas() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    fitCanvas();
    window.addEventListener("resize", fitCanvas);

    var nodes = data.nodes.map(function (n, i) {
      return {
        id: n.id, label: n.label, kind: n.kind, color: n.color || colorForKind(n.kind),
        r: n.r || 6,
        x: canvas.clientWidth / 2 + Math.cos(i) * 60,
        y: canvas.clientHeight / 2 + Math.sin(i) * 60,
        vx: 0, vy: 0,
        pinned: false,
        ref: n,
      };
    });
    var idIx = {}; nodes.forEach(function (n, i) { idIx[n.id] = i; });
    var edges = data.edges.filter(function (e) { return idIx[e.src] != null && idIx[e.dst] != null; }).map(function (e) {
      return { s: nodes[idIx[e.src]], t: nodes[idIx[e.dst]], kind: e.kind, color: e.color || edgeColor(e.kind), label: e.label, strength: Number(e.strength) || 1, ref: e };
    });

    // Highlight a single node (used to mark the "anchor" of the subgraph).
    var anchorId = opts.anchorId != null ? opts.anchorId : null;

    var REPULSE = opts.repulse || 1200;
    var SPRING = opts.spring || 0.02;
    var SPRING_LEN = opts.springLen || 80;
    var GRAVITY = opts.gravity || 0.012;
    var DAMP = 0.85;
    var STOP_VEL = 0.05;
    var stopped = false;
    var hover = null;
    var dragging = null;
    var pan = { x: 0, y: 0 };
    var zoom = 1;

    function step() {
      if (stopped) return;
      var W = canvas.clientWidth, H = canvas.clientHeight;
      var cx = W / 2, cy = H / 2;
      var moving = false;
      // O(N²) repulsion — fine for ≤200 nodes (40k pairs).
      for (var i = 0; i < nodes.length; i++) {
        var a = nodes[i]; if (a.pinned) continue;
        var fx = (cx - a.x) * GRAVITY, fy = (cy - a.y) * GRAVITY;
        for (var j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          var b = nodes[j];
          var dx = a.x - b.x, dy = a.y - b.y;
          var d2 = dx * dx + dy * dy + 0.01;
          var f = REPULSE / d2;
          fx += (dx / Math.sqrt(d2)) * f;
          fy += (dy / Math.sqrt(d2)) * f;
        }
        a.vx = (a.vx + fx) * DAMP;
        a.vy = (a.vy + fy) * DAMP;
      }
      // Spring forces along edges.
      for (var k = 0; k < edges.length; k++) {
        var e = edges[k]; var s = e.s, t = e.t;
        var dx2 = t.x - s.x, dy2 = t.y - s.y;
        var d = Math.sqrt(dx2 * dx2 + dy2 * dy2) + 0.01;
        var disp = (d - SPRING_LEN) * SPRING;
        var ux = dx2 / d, uy = dy2 / d;
        if (!s.pinned) { s.vx += ux * disp; s.vy += uy * disp; }
        if (!t.pinned) { t.vx -= ux * disp; t.vy -= uy * disp; }
      }
      // Integrate.
      for (var n2 = 0; n2 < nodes.length; n2++) {
        var nd = nodes[n2]; if (nd.pinned) continue;
        nd.x += nd.vx; nd.y += nd.vy;
        if (Math.abs(nd.vx) + Math.abs(nd.vy) > STOP_VEL) moving = true;
      }
      draw();
      if (moving) requestAnimationFrame(step); else stopped = true;
    }

    function worldFromScreen(sx, sy) {
      return { x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom };
    }

    function draw() {
      ctx.save();
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.translate(pan.x, pan.y); ctx.scale(zoom, zoom);
      // Edges first.
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        ctx.strokeStyle = rgb(e.color);
        // Edge width scales by strength (1..6 → 1.0..3.6 px). Stronger
        // co-investment / mention overlaps render thicker so hub
        // relationships are visually distinguishable.
        var s = Math.max(1, Math.min(6, e.strength || 1));
        ctx.lineWidth = 0.8 + s * 0.45;
        ctx.beginPath(); ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); ctx.stroke();
      }
      // Nodes.
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        var isAnchor = n.id === anchorId;
        var isHover = hover === n;
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + (isAnchor ? 4 : 0) + (isHover ? 2 : 0), 0, Math.PI * 2);
        ctx.fill();
        if (isAnchor || isHover) {
          ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.stroke();
        }
        if (isHover || isAnchor) {
          ctx.fillStyle = "#111"; ctx.font = "11px system-ui, sans-serif";
          ctx.fillText(n.label || "", n.x + 10, n.y - 6);
        }
      }
      ctx.restore();
    }

    function pickNode(sx, sy) {
      var w = worldFromScreen(sx, sy);
      for (var i = nodes.length - 1; i >= 0; i--) {
        var n = nodes[i];
        var dx = w.x - n.x, dy = w.y - n.y;
        if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) return n;
      }
      return null;
    }
    function evCoords(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
    canvas.addEventListener("mousemove", function (ev) {
      var p = evCoords(ev);
      if (dragging && dragging.__pan) {
        // Background drag → pan the viewport.
        pan.x = p.x - dragging.sx;
        pan.y = p.y - dragging.sy;
        draw();
        return;
      }
      if (dragging) {
        var w = worldFromScreen(p.x, p.y);
        dragging.x = w.x; dragging.y = w.y; dragging.vx = 0; dragging.vy = 0;
        stopped = false; requestAnimationFrame(step);
        return;
      }
      var n = pickNode(p.x, p.y);
      if (n !== hover) {
        hover = n;
        canvas.style.cursor = n ? "pointer" : "grab";
        canvas.dispatchEvent(new CustomEvent("node:hover", { detail: n ? n.ref : null }));
        draw();
      }
    });
    canvas.addEventListener("mousedown", function (ev) {
      var p = evCoords(ev);
      var n = pickNode(p.x, p.y);
      if (n) { dragging = n; n.pinned = true; }
      else { dragging = { __pan: true, sx: p.x - pan.x, sy: p.y - pan.y }; }
    });
    canvas.addEventListener("mouseup", function () {
      if (dragging && !dragging.__pan) dragging.pinned = false;
      dragging = null;
    });
    canvas.addEventListener("click", function (ev) {
      var p = evCoords(ev);
      var n = pickNode(p.x, p.y);
      if (n) canvas.dispatchEvent(new CustomEvent("node:click", { detail: n.ref }));
    });
    canvas.addEventListener("dblclick", function (ev) {
      var p = evCoords(ev);
      var n = pickNode(p.x, p.y);
      if (n) canvas.dispatchEvent(new CustomEvent("node:dblclick", { detail: n.ref }));
    });
    canvas.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var p = evCoords(ev);
      var w = worldFromScreen(p.x, p.y);
      var k = ev.deltaY < 0 ? 1.1 : 0.9;
      zoom = Math.max(0.2, Math.min(3, zoom * k));
      pan.x = p.x - w.x * zoom; pan.y = p.y - w.y * zoom;
      draw();
    }, { passive: false });

    requestAnimationFrame(step);
    return {
      stop: function () { stopped = true; },
      redraw: draw,
      zoomTo: function (id) {
        var ix = idIx[id]; if (ix == null) return;
        var n = nodes[ix];
        zoom = 1;
        pan.x = canvas.clientWidth / 2 - n.x;
        pan.y = canvas.clientHeight / 2 - n.y;
        draw();
      },
      // Merge additional nodes/edges into the live graph (used by
      // expand-on-double-click). Existing nodes keep their positions.
      addData: function (extra) {
        var added = 0;
        (extra.nodes || []).forEach(function (n) {
          if (idIx[n.id] != null) return;
          var nn = {
            id: n.id, label: n.label, kind: n.kind, color: colorForKind(n.kind),
            r: 6,
            x: canvas.clientWidth / 2 + (Math.random() - 0.5) * 80,
            y: canvas.clientHeight / 2 + (Math.random() - 0.5) * 80,
            vx: 0, vy: 0, pinned: false, ref: n,
          };
          idIx[n.id] = nodes.length;
          nodes.push(nn);
          added++;
        });
        (extra.edges || []).forEach(function (e) {
          if (idIx[e.src] == null || idIx[e.dst] == null) return;
          edges.push({ s: nodes[idIx[e.src]], t: nodes[idIx[e.dst]], kind: e.kind, color: edgeColor(e.kind), label: e.label, strength: Number(e.strength) || 1, ref: e });
        });
        if (added) { stopped = false; requestAnimationFrame(step); }
      },
      // Hide nodes (and incident edges) by id (used by collapse).
      removeNodes: function (ids) {
        var rm = {}; ids.forEach(function (i) { rm[i] = true; });
        nodes = nodes.filter(function (n) { return !rm[n.id]; });
        edges = edges.filter(function (e) { return !rm[e.s.id] && !rm[e.t.id]; });
        idIx = {}; nodes.forEach(function (n, i) { idIx[n.id] = i; });
        draw();
      },
    };
  }
  window.ADSForceGraph = ForceGraph;
  window.ADSForceGraph.colorForKind = colorForKind;
  window.ADSForceGraph.edgeColor = edgeColor;
})();
