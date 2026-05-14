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

  var GEOS = [];
  async function load() {
    var s = await api("/api/taxonomies/sectors");
    renderSectors(s && s.items);
    var g = await api("/api/taxonomies/geographies");
    GEOS = (g && g.items) || [];
    renderGeos(GEOS, "");
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-geo-kind]");
    if (!btn) return;
    document.querySelectorAll("button[data-geo-kind]").forEach(function (b) { b.classList.toggle("active", b === btn); });
    renderGeos(GEOS, btn.getAttribute("data-geo-kind"));
  });

  document.addEventListener("DOMContentLoaded", function () {
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
