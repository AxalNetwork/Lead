(function () {
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function api(p, opts) { return window.adsApiFetch(p, opts); }
  function arr(s) { return String(s || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
  function showMsg(form, text, kind) {
    var el = form.querySelector("[data-msg]"); if (!el) return;
    el.textContent = text || ""; el.className = "ads-form-msg" + (kind ? " ads-form-msg--" + kind : "");
  }

  var CURRENT_ID = null;
  var TAX_CACHE = { sectors: null, geographies: null };
  var PICKERS = {};

  async function loadTaxonomy(kind) {
    if (TAX_CACHE[kind]) return TAX_CACHE[kind];
    var path = kind === "sectors" ? "/api/taxonomies/sectors" : "/api/taxonomies/geographies";
    try {
      var data = await api(path);
      TAX_CACHE[kind] = (data && data.items) || [];
    } catch (e) { TAX_CACHE[kind] = []; }
    return TAX_CACHE[kind];
  }

  function buildPicker(host) {
    var kind = host.getAttribute("data-picker");
    var hidden = host.querySelector('input[type="hidden"]');
    var placeholder = host.getAttribute("data-placeholder") || "Search…";
    host.innerHTML = "";
    host.appendChild(hidden);
    var chips = document.createElement("div"); chips.className = "ads-picker__chips";
    var input = document.createElement("input");
    input.type = "text"; input.className = "ads-picker__input";
    input.placeholder = placeholder; input.autocomplete = "off";
    var dropdown = document.createElement("div"); dropdown.className = "ads-picker__dropdown"; dropdown.hidden = true;
    chips.appendChild(input);
    host.appendChild(chips);
    host.appendChild(dropdown);

    var state = { kind: kind, items: [], byslug: {}, selected: [], host: host, hidden: hidden, chips: chips, input: input, dropdown: dropdown, active: -1 };

    function render() {
      // Re-render chips before the input
      Array.prototype.slice.call(chips.querySelectorAll(".ads-chip")).forEach(function (n) { n.remove(); });
      state.selected.forEach(function (slug) {
        var item = state.byslug[slug];
        var label = item ? item.label : slug;
        var chip = document.createElement("span"); chip.className = "ads-chip";
        chip.innerHTML = '<span class="ads-chip__label"></span><button type="button" class="ads-chip__x" aria-label="Remove">×</button>';
        chip.querySelector(".ads-chip__label").textContent = label + " ";
        var code = document.createElement("code"); code.className = "ads-chip__slug"; code.textContent = slug;
        chip.querySelector(".ads-chip__label").appendChild(code);
        chip.querySelector(".ads-chip__x").addEventListener("click", function () { remove(slug); });
        chips.insertBefore(chip, input);
      });
      hidden.value = state.selected.join(",");
    }
    function add(slug) {
      if (!slug || state.selected.indexOf(slug) !== -1) return;
      state.selected.push(slug); render();
      input.value = ""; renderDropdown("");
    }
    function remove(slug) {
      state.selected = state.selected.filter(function (s) { return s !== slug; });
      render(); renderDropdown(input.value);
    }
    function matchesQuery(item, q) {
      if (!q) return true;
      q = q.toLowerCase();
      if ((item.label || "").toLowerCase().indexOf(q) !== -1) return true;
      if ((item.slug || "").toLowerCase().indexOf(q) !== -1) return true;
      if (item.country_iso2 && item.country_iso2.toLowerCase().indexOf(q) !== -1) return true;
      var aliases = item.aliases || [];
      for (var i = 0; i < aliases.length; i++) {
        if (String(aliases[i]).toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    }
    function renderDropdown(q) {
      var pool = state.items.filter(function (i) { return state.selected.indexOf(i.slug) === -1 && matchesQuery(i, q); });
      pool = pool.slice(0, 50);
      state.active = pool.length ? 0 : -1;
      if (!pool.length) {
        dropdown.innerHTML = '<div class="ads-picker__empty">No matches</div>';
      } else {
        var html = "";
        pool.forEach(function (it, idx) {
          var meta = it.country_iso2 ? it.country_iso2 : (it.kind || "");
          html += '<div class="ads-picker__opt' + (idx === 0 ? ' active' : '') + '" data-slug="' + esc(it.slug) + '">' +
            '<span class="ads-picker__opt-label">' + esc(it.label || it.slug) + '</span>' +
            '<span class="ads-picker__opt-meta"><code>' + esc(it.slug) + '</code>' + (meta ? ' · ' + esc(meta) : '') + '</span>' +
            '</div>';
        });
        dropdown.innerHTML = html;
      }
      dropdown.hidden = false;
    }
    function close() { dropdown.hidden = true; state.active = -1; }
    function moveActive(delta) {
      var opts = dropdown.querySelectorAll(".ads-picker__opt");
      if (!opts.length) return;
      state.active = (state.active + delta + opts.length) % opts.length;
      opts.forEach(function (o, i) { o.classList.toggle("active", i === state.active); });
      var el = opts[state.active]; if (el) el.scrollIntoView({ block: "nearest" });
    }
    function commitActive() {
      var opts = dropdown.querySelectorAll(".ads-picker__opt");
      var el = opts[state.active] || opts[0];
      if (el) add(el.getAttribute("data-slug"));
    }

    input.addEventListener("focus", function () { renderDropdown(input.value); });
    input.addEventListener("input", function () { renderDropdown(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (dropdown.hidden) renderDropdown(input.value); else moveActive(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
      else if (e.key === "Enter") {
        if (!dropdown.hidden) { e.preventDefault(); commitActive(); }
      } else if (e.key === "Escape") { close(); }
      else if (e.key === "Backspace" && !input.value && state.selected.length) {
        remove(state.selected[state.selected.length - 1]);
      }
    });
    dropdown.addEventListener("mousedown", function (e) {
      var opt = e.target.closest(".ads-picker__opt"); if (!opt) return;
      e.preventDefault(); add(opt.getAttribute("data-slug"));
    });
    document.addEventListener("click", function (e) { if (!host.contains(e.target)) close(); });
    chips.addEventListener("click", function (e) { if (e.target === chips) input.focus(); });

    PICKERS[kind] = {
      setSelected: function (slugs) { state.selected = (slugs || []).slice(); render(); },
      getSelected: function () { return state.selected.slice(); },
      setItems: function (items) {
        state.items = items || [];
        state.byslug = {};
        state.items.forEach(function (i) { state.byslug[i.slug] = i; });
        render();
      },
    };
    return PICKERS[kind];
  }

  async function initPickers() {
    var hosts = document.querySelectorAll(".ads-picker");
    hosts.forEach(buildPicker);
    var sectors = await loadTaxonomy("sectors");
    if (PICKERS.sectors) PICKERS.sectors.setItems(sectors);
    var geos = await loadTaxonomy("geographies");
    if (PICKERS.geographies) PICKERS.geographies.setItems(geos);
  }

  async function loadList() {
    var c = document.getElementById("ads-icp-list");
    try {
      var data = await api("/api/icp");
      var items = (data && data.items) || [];
      if (!items.length) { c.innerHTML = '<div class="ads-empty">No ICPs yet — click + New ICP.</div>'; return; }
      var html = '<table class="ads-table ads-table--clickable"><thead><tr><th>Name</th><th>Description</th><th>Sectors</th><th>Geographies</th><th>Updated</th><th></th></tr></thead><tbody>';
      items.forEach(function (i) {
        html += "<tr data-icp-id='" + esc(i.id) + "'>" +
          "<td>" + esc(i.name) + "</td>" +
          "<td class='ads-muted'>" + esc(i.description || "") + "</td>" +
          "<td class='ads-muted' style='font-size:11px'>" + esc((JSON.parse(i.sectors_json || '[]')).join(", ")) + "</td>" +
          "<td class='ads-muted' style='font-size:11px'>" + esc((JSON.parse(i.geographies_json || '[]')).join(", ")) + "</td>" +
          "<td>" + esc(new Date(i.updated_at).toLocaleString()) + "</td>" +
          "<td><button class='ads-btn ads-btn--sm' data-icp-edit='" + esc(i.id) + "'>Edit</button> " +
              "<button class='ads-btn ads-btn--sm' data-icp-preview='" + esc(i.id) + "'>Preview</button> " +
              "<button class='ads-btn ads-btn--ghost ads-btn--sm' data-icp-del='" + esc(i.id) + "'>Delete</button></td>" +
          "</tr>";
      });
      c.innerHTML = html + "</tbody></table>";
    } catch (e) { c.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; }
  }

  function openEditor(icp) {
    var card = document.getElementById("ads-icp-editor");
    var form = document.getElementById("ads-icp-form");
    document.getElementById("ads-icp-editor-title").textContent = icp ? ("Edit: " + icp.name) : "New ICP";
    form.reset();
    if (icp) {
      form.elements["id"].value = icp.id;
      form.name.value = icp.name || "";
      form.description.value = icp.description || "";
      var secs = JSON.parse(icp.sectors_json || '[]');
      var geos = JSON.parse(icp.geographies_json || '[]');
      form.sectors.value = secs.join(",");
      form.geographies.value = geos.join(",");
      if (PICKERS.sectors) PICKERS.sectors.setSelected(secs);
      if (PICKERS.geographies) PICKERS.geographies.setSelected(geos);
      form.personas.value = (JSON.parse(icp.personas_json || '[]')).join(", ");
      form.seniority.value = (JSON.parse(icp.seniority_json || '[]')).join(", ");
      form.min_aum_usd.value = icp.min_aum_usd || "";
      form.min_fund_size_usd.value = icp.min_fund_size_usd || "";
      form.min_quality.value = icp.min_quality || "";
      form.require_email.checked = !!icp.require_email;
      form.require_linkedin.checked = !!icp.require_linkedin;
      form.exclude_dnc.checked = icp.exclude_dnc !== 0;
    } else {
      form.elements["id"].value = "";
      form.exclude_dnc.checked = true;
      if (PICKERS.sectors) PICKERS.sectors.setSelected([]);
      if (PICKERS.geographies) PICKERS.geographies.setSelected([]);
    }
    card.style.display = "block";
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function saveIcp(e) {
    e.preventDefault();
    var form = e.target;
    var id = form.elements["id"].value;
    var body = {
      name: form.name.value,
      description: form.description.value || null,
      sectors_json: arr(form.sectors.value),
      geographies_json: arr(form.geographies.value),
      personas_json: arr(form.personas.value),
      seniority_json: arr(form.seniority.value),
      min_aum_usd: form.min_aum_usd.value ? Number(form.min_aum_usd.value) : null,
      min_fund_size_usd: form.min_fund_size_usd.value ? Number(form.min_fund_size_usd.value) : null,
      min_quality: form.min_quality.value ? Number(form.min_quality.value) : null,
      require_email: form.require_email.checked ? 1 : 0,
      require_linkedin: form.require_linkedin.checked ? 1 : 0,
      exclude_dnc: form.exclude_dnc.checked ? 1 : 0,
    };
    showMsg(form, "Saving…");
    try {
      if (id) await api("/api/icp/" + encodeURIComponent(id), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      else await api("/api/icp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      showMsg(form, "Saved.", "ok");
      document.getElementById("ads-icp-editor").style.display = "none";
      loadList();
    } catch (err) { showMsg(form, "Failed: " + err.message, "err"); }
  }

  async function previewIcp(id) {
    CURRENT_ID = id;
    var card = document.getElementById("ads-icp-preview-card");
    var c = document.getElementById("ads-icp-preview");
    card.style.display = "block";
    c.innerHTML = '<div class="ads-loading">Matching…</div>';
    try {
      var data = await api("/api/icp/" + encodeURIComponent(id) + "/match?limit=100");
      var items = (data && data.items) || [];
      document.getElementById("ads-icp-preview-meta").textContent = "(" + (data.total || 0) + " matches, showing " + items.length + ")";
      if (!items.length) { c.innerHTML = '<div class="ads-empty">No matches.</div>'; return; }
      var html = '<table class="ads-table"><thead><tr><th>Score</th><th>Name</th><th>Org</th><th>Email</th><th>Reasons</th></tr></thead><tbody>';
      items.forEach(function (m) {
        html += "<tr><td>" + m.score.toFixed(3) + "</td><td>" + esc(m.name || "—") + "</td><td>" + esc(m.org || "—") + "</td><td>" + esc(m.email || "—") + "</td><td class='ads-muted' style='font-size:11px'>" + esc((m.reasons || []).join(", ")) + "</td></tr>";
      });
      c.innerHTML = html + "</tbody></table>";
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { c.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; }
  }

  document.addEventListener("click", async function (e) {
    var newBtn = e.target.closest("#ads-icp-new");
    if (newBtn) { openEditor(null); return; }
    var cancel = e.target.closest("#ads-icp-cancel");
    if (cancel) { document.getElementById("ads-icp-editor").style.display = "none"; return; }
    var edit = e.target.closest("button[data-icp-edit]");
    if (edit) { var r = await api("/api/icp/" + encodeURIComponent(edit.getAttribute("data-icp-edit"))); openEditor(r); return; }
    var prev = e.target.closest("button[data-icp-preview]");
    if (prev) { previewIcp(prev.getAttribute("data-icp-preview")); return; }
    var del = e.target.closest("button[data-icp-del]");
    if (del) { if (!confirm("Delete this ICP?")) return; await api("/api/icp/" + encodeURIComponent(del.getAttribute("data-icp-del")), { method: "DELETE" }); loadList(); return; }
    var make = e.target.closest("#ads-icp-make-campaign");
    if (make && CURRENT_ID) {
      var name = prompt("Campaign name?");
      if (!name) return;
      try {
        var c = await api("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name, icp_id: CURRENT_ID, channel: "email" }) });
        window.location.href = "/dashboard/campaigns/?id=" + encodeURIComponent(c.id);
      } catch (err) { alert("Failed: " + err.message); }
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    if (!document.getElementById("ads-icp-list")) return;
    loadList();
    initPickers();
    var form = document.getElementById("ads-icp-form");
    if (form) form.addEventListener("submit", saveIcp);
  });
})();
