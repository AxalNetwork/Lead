(function () {
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  async function api(path) { try { return await window.adsApiFetch(path); } catch (e) { console.warn(path, e); return null; } }

  function renderSectors(items) {
    var c = document.getElementById("ads-tax-sectors");
    if (!c) return;
    if (!items || !items.length) { c.innerHTML = '<div class="ads-empty">No sectors.</div>'; return; }
    var html = '<table class="ads-table"><thead><tr><th>Slug</th><th>Label</th><th>Aliases</th></tr></thead><tbody>';
    items.forEach(function (s) {
      html += "<tr><td><code>" + esc(s.slug) + "</code></td><td>" + esc(s.label) + "</td><td class='ads-muted' style='font-size:11px'>" + esc((s.aliases || []).slice(0, 5).join(", ")) + "</td></tr>";
    });
    c.innerHTML = html + "</tbody></table>";
  }

  function renderGeos(items, kind) {
    var c = document.getElementById("ads-tax-geos");
    if (!c) return;
    var filtered = kind ? items.filter(function (g) { return g.kind === kind; }) : items;
    if (!filtered.length) { c.innerHTML = '<div class="ads-empty">No matches.</div>'; return; }
    var html = '<table class="ads-table"><thead><tr><th>Slug</th><th>Label</th><th>Kind</th><th>Country</th></tr></thead><tbody>';
    filtered.slice(0, 500).forEach(function (g) {
      html += "<tr><td><code>" + esc(g.slug) + "</code></td><td>" + esc(g.label) + "</td><td>" + esc(g.kind) + "</td><td>" + esc(g.country_iso2 || "") + "</td></tr>";
    });
    c.innerHTML = html + "</tbody></table>";
  }

  function renderHeatmap(cells) {
    var c = document.getElementById("ads-heatmap");
    if (!c) return;
    if (!cells || !cells.length) { c.innerHTML = '<div class="ads-empty">No leads to map yet.</div>'; return; }
    // Pivot into sector(rows) × country(cols).
    var sectors = {}, countries = {}, byKey = {};
    cells.forEach(function (cell) {
      sectors[cell.sector] = (sectors[cell.sector] || 0) + cell.n;
      countries[cell.country] = (countries[cell.country] || 0) + cell.n;
      byKey[cell.sector + "|" + cell.country] = cell.n;
    });
    var topSectors = Object.keys(sectors).sort(function (a, b) { return sectors[b] - sectors[a]; }).slice(0, 20);
    var topCountries = Object.keys(countries).sort(function (a, b) { return countries[b] - countries[a]; }).slice(0, 18);
    var max = 0;
    topSectors.forEach(function (s) { topCountries.forEach(function (g) { var v = byKey[s + "|" + g] || 0; if (v > max) max = v; }); });

    var html = '<div style="overflow:auto"><table class="ads-table" style="min-width:600px"><thead><tr><th style="position:sticky;left:0;background:var(--ads-card)">Sector ↓ / Country →</th>';
    topCountries.forEach(function (g) {
      html += '<th title="' + esc(g) + '" style="text-align:center;font-size:11px">' + esc(g === "__unmapped__" ? "—" : g) + "</th>";
    });
    html += "</tr></thead><tbody>";
    topSectors.forEach(function (s) {
      html += '<tr><td style="position:sticky;left:0;background:var(--ads-card);font-weight:500"><code>' + esc(s === "__unmapped__" ? "—" : s) + "</code></td>";
      topCountries.forEach(function (g) {
        var v = byKey[s + "|" + g] || 0;
        var alpha = max ? (0.08 + 0.82 * (v / max)) : 0;
        var bg = v ? "background:rgba(99,179,237," + alpha.toFixed(2) + ")" : "";
        html += '<td style="text-align:center;' + bg + '" title="' + esc(s) + " · " + esc(g) + ": " + v + '">' + (v || "") + "</td>";
      });
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    c.innerHTML = html;
  }

  var GEOS = [];
  async function load() {
    var s = await api("/api/taxonomies/sectors");
    renderSectors(s && s.items);
    var g = await api("/api/taxonomies/geographies");
    GEOS = (g && g.items) || [];
    renderGeos(GEOS, "");
    var h = await api("/api/taxonomies/heatmap");
    renderHeatmap(h && h.cells);
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-geo-kind]");
    if (!btn) return;
    document.querySelectorAll("button[data-geo-kind]").forEach(function (b) { b.classList.toggle("active", b === btn); });
    renderGeos(GEOS, btn.getAttribute("data-geo-kind"));
  });

  document.addEventListener("DOMContentLoaded", function () {
    if (!document.getElementById("ads-tax-sectors")) return;
    load();
    var btn = document.getElementById("ads-resolve-btn");
    var input = document.getElementById("ads-resolve-q");
    var out = document.getElementById("ads-resolve-out");
    if (btn && input) {
      btn.addEventListener("click", async function () {
        var q = input.value.trim();
        if (!q) return;
        var r = await api("/api/taxonomies/resolve?q=" + encodeURIComponent(q));
        out.style.display = "block";
        out.textContent = JSON.stringify(r, null, 2);
      });
    }
  });
})();
