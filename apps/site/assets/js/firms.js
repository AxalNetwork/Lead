// Firms search page (Task #20).
// Filter form -> querystring -> /api/firms (list), /api/firms/aggregate
// (summary strip), /api/saved-filters (sidebar), /api/taxonomies/sectors
// (sector multi-select source).
(function () {
  if (!document.getElementById("ads-firms-filters")) return;

  var API_BASE = (window.ADS && window.ADS.apiBase);

  var DEFAULT_COLS = ["name", "kind", "hq", "stages", "sectors", "check_size_typical_usd", "aum_usd", "lead_or_co", "portfolio_count", "last_modified"];
  var ALL_COLS = DEFAULT_COLS.concat(["website", "founded_year", "team_size", "unicorns_count", "exits_count", "contact_email", "status", "quality_score"]);
  // Maps display column -> server sort key. The HQ cell shows "city, country",
  // so it sorts by hq_city (its leading value); the backend allowlist exposes
  // hq_city. Stages/Sectors/Lead-or-co stay non-sortable (composite JSON).
  var SORT_KEYS = {
    name: "name", kind: "kind", hq: "hq_city",
    check_size_typical_usd: "check_size_typical_usd",
    aum_usd: "aum_usd", portfolio_count: "portfolio_count",
    last_modified: "last_modified", founded_year: "founded_year",
    unicorns_count: "unicorns_count", exits_count: "exits_count",
    quality_score: "quality_score",
  };

  var state = {
    cols: load("ads_firms_cols", DEFAULT_COLS),
    nextCursor: null,
    items: [],
    sort_by: "",
    sort_dir: "desc",
  };

  function load(k, fb) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (_) { return fb; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtMoney(n) { if (!n) return "—"; if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k"; return "$" + n; }
  function fmtArr(j) { try { var a = JSON.parse(j); return Array.isArray(a) ? a.join(", ") : ""; } catch (_) { return ""; } }
  function fmtDate(d) { return d ? String(d).slice(0, 10) : ""; }

  // Multi-select aware: each multi-select contributes comma-joined values
  // under a single key — the server's parseFirmFilter already accepts this.
  function buildQS(form) {
    var p = new URLSearchParams();
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if (el.type === "checkbox") { if (el.checked) p.set(el.name, el.value || "1"); return; }
      if (el.tagName === "SELECT" && el.multiple) {
        var vals = []; for (var i = 0; i < el.options.length; i++) if (el.options[i].selected) vals.push(el.options[i].value);
        if (vals.length) p.set(el.name, vals.join(","));
        return;
      }
      var v = String(el.value || "").trim();
      if (v) p.set(el.name, v);
    });
    if (state.sort_by) { p.set("sort_by", state.sort_by); p.set("sort_dir", state.sort_dir); }
    return p;
  }

  function readQS() {
    var p = new URLSearchParams(window.location.search);
    var form = document.getElementById("ads-firms-filters");
    p.forEach(function (v, k) {
      if (k === "sort_by") { state.sort_by = v; return; }
      if (k === "sort_dir") { state.sort_dir = v; return; }
      var el = form.elements[k]; if (!el) return;
      if (el.type === "checkbox") el.checked = (v === "1" || v === "true");
      else if (el.tagName === "SELECT" && el.multiple) {
        var set = v.split(",");
        for (var i = 0; i < el.options.length; i++) el.options[i].selected = set.indexOf(el.options[i].value) !== -1;
      } else el.value = v;
    });
  }

  function syncURL(p) {
    var qs = p.toString();
    var url = window.location.pathname + (qs ? "?" + qs : "");
    window.history.replaceState({}, "", url);
  }

  function rowFor(f, col) {
    switch (col) {
      case "name": return '<span data-dd-ref="' + esc(f.id) + '"><a href="/dashboard/firms/detail/?id=' + f.id + '">' + esc(f.name) + '</a><span data-dd-slot></span></span>';
      case "kind": return esc(f.kind || "");
      case "hq": return esc([f.hq_city, f.hq_country_iso2].filter(Boolean).join(", "));
      case "stages": return esc(fmtArr(f.stages_json));
      case "sectors": return esc(fmtArr(f.sectors_json));
      case "check_size_typical_usd": return fmtMoney(f.check_size_typical_usd);
      case "aum_usd": return fmtMoney(f.aum_usd);
      case "lead_or_co": return esc(f.lead_or_co || "");
      case "portfolio_count": return f.portfolio_count != null ? f.portfolio_count : "";
      case "last_modified": return fmtDate(f.last_modified);
      case "website": return f.website ? '<a href="' + esc(f.website) + '" target="_blank" rel="noopener">' + esc(f.website.replace(/^https?:\/\//, "")) + '</a>' : "";
      case "founded_year": return f.founded_year || "";
      case "team_size": return f.team_size || "";
      case "unicorns_count": return f.unicorns_count || 0;
      case "exits_count": return f.exits_count || 0;
      case "contact_email": return esc(f.contact_email || "");
      case "status": return esc(f.status || "");
      case "quality_score": return f.quality_score != null ? Number(f.quality_score).toFixed(2) : "";
    }
    return esc(String(f[col] == null ? "" : f[col]));
  }

  function renderTable() {
    var thead = document.getElementById("ads-firms-thead");
    thead.innerHTML = state.cols.map(function (c) {
      var sortable = !!SORT_KEYS[c];
      var ind = "";
      if (sortable && state.sort_by === SORT_KEYS[c]) ind = state.sort_dir === "asc" ? " ▲" : " ▼";
      var cursor = sortable ? "cursor:pointer" : "cursor:default";
      return '<th data-col="' + esc(c) + '" style="text-align:left;padding:6px;border-bottom:1px solid #eee;font-size:12px;text-transform:uppercase;color:#667;' + cursor + '">' + esc(c) + esc(ind) + '</th>';
    }).join("");
    thead.querySelectorAll("th").forEach(function (th) {
      var col = th.dataset.col, key = SORT_KEYS[col];
      if (!key) return;
      th.addEventListener("click", function () {
        if (state.sort_by === key) state.sort_dir = state.sort_dir === "asc" ? "desc" : "asc";
        else { state.sort_by = key; state.sort_dir = "asc"; }
        state.nextCursor = null;
        loadResults(false);
      });
    });
    var tbody = document.getElementById("ads-firms-tbody");
    if (!state.items.length) { tbody.innerHTML = '<tr><td colspan="' + state.cols.length + '" class="ads-muted" style="padding:12px">No matches.</td></tr>'; return; }
    tbody.innerHTML = state.items.map(function (f) {
      return '<tr style="cursor:pointer" data-id="' + f.id + '">' + state.cols.map(function (c) {
        return '<td style="padding:6px;border-bottom:1px solid #f4f4f4;font-size:13px">' + rowFor(f, c) + '</td>';
      }).join("") + '</tr>';
    }).join("");
    tbody.querySelectorAll("tr").forEach(function (tr) {
      tr.addEventListener("click", function (e) {
        if (e.target && e.target.tagName === "A") return;
        window.location.href = "/dashboard/firms/detail/?id=" + tr.dataset.id;
      });
    });
    document.getElementById("ads-firms-shown").textContent = state.items.length + " row" + (state.items.length === 1 ? "" : "s");
    var more = document.getElementById("ads-firms-loadmore");
    more.hidden = !state.nextCursor;
    if (window.ADS_DDBadge) window.ADS_DDBadge.decorate("firms", tbody);
  }

  function api(path, opts) { return window.adsUtil.request(API_BASE + path, Object.assign({ credentials: "include" }, opts || {})).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }

  function loadResults(append) {
    var p = buildQS(document.getElementById("ads-firms-filters"));
    syncURL(p);
    if (append && state.nextCursor) p.set("cursor", String(state.nextCursor));
    return api("/api/firms?" + p.toString()).then(function (data) {
      state.nextCursor = data.nextCursor || null;
      state.items = append ? state.items.concat(data.items || []) : (data.items || []);
      renderTable();
    }).catch(function () {
      document.getElementById("ads-firms-tbody").innerHTML = '<tr><td colspan="' + state.cols.length + '" class="ads-muted" style="padding:12px">Failed to load.</td></tr>';
    });
  }

  function loadSummary() {
    var p = buildQS(document.getElementById("ads-firms-filters"));
    p.delete("sort_by"); p.delete("sort_dir");
    return api("/api/firms/aggregate?" + p.toString()).then(function (s) {
      var card = document.getElementById("ads-firms-summary");
      card.querySelector('[data-k="count"]').textContent = (s.count || 0).toLocaleString();
      card.querySelector('[data-k="aum"]').textContent = fmtMoney(s.total_aum_usd);
      card.querySelector('[data-k="median"]').textContent = fmtMoney(s.median_check_size_usd);
      card.querySelector('[data-k="sectors"]').innerHTML = (s.top_sectors || []).map(function (x) { return esc(x.slug) + " (" + x.count + ")"; }).join("<br>") || "—";
      card.querySelector('[data-k="cities"]').innerHTML = (s.top_cities || []).map(function (x) { return esc(x.k) + " (" + x.n + ")"; }).join("<br>") || "—";
    }).catch(function () { /* non-critical */ });
  }

  function loadViews() {
    var ul = document.getElementById("ads-firms-views-list");
    return api("/api/saved-filters?entity=firms").then(function (data) {
      var items = (data && data.items) || [];
      if (!items.length) { ul.innerHTML = '<li class="ads-muted">No saved views yet.</li>'; return; }
      ul.innerHTML = items.map(function (v) {
        return '<li style="margin:4px 0;display:flex;justify-content:space-between;align-items:center"><a href="?' + esc(v.querystring) + '">' + esc(v.name) + '</a><button class="ads-view-del" data-id="' + v.id + '" style="background:none;border:none;color:#a00;cursor:pointer">&times;</button></li>';
      }).join("");
      ul.querySelectorAll(".ads-view-del").forEach(function (b) {
        b.addEventListener("click", async function (e) {
          e.preventDefault();
          if (!(await window.ADS.ui.confirm({ title: "Delete saved view?", body: "This filter will be removed from your saved views.", confirmLabel: "Delete", danger: true }))) return;
          window.adsUtil.request(API_BASE + "/api/saved-filters/" + b.dataset.id, { method: "DELETE", credentials: "include" }).then(loadViews);
        });
      });
    }).catch(function () { ul.innerHTML = '<li class="ads-muted">Failed to load.</li>'; });
  }

  // Chip-style picker (mirror of icps.js; a future task extracts this into a
  // shared widget). Each .ads-picker host has data-picker (taxonomy kind) and
  // wraps a hidden input that round-trips the comma-joined slug list through
  // the existing query string.
  var TAX_CACHE = {};
  var PICKERS = {};

  function loadTaxonomy(kind) {
    if (TAX_CACHE[kind]) return Promise.resolve(TAX_CACHE[kind]);
    var path = kind === "sectors" ? "/api/taxonomies/sectors" : "/api/taxonomies/geographies";
    return api(path).then(function (data) {
      TAX_CACHE[kind] = (data && data.items) || [];
      return TAX_CACHE[kind];
    }).catch(function () { TAX_CACHE[kind] = []; return TAX_CACHE[kind]; });
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

    var state = { items: [], byslug: {}, selected: [], active: -1 };

    function render() {
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

    var key = hidden.name || kind;
    PICKERS[key] = {
      setSelected: function (slugs) { state.selected = (slugs || []).slice(); render(); },
      getSelected: function () { return state.selected.slice(); },
      setItems: function (items) {
        state.items = items || [];
        state.byslug = {};
        state.items.forEach(function (i) { state.byslug[i.slug] = i; });
        render();
      },
      kind: kind,
    };
    return PICKERS[key];
  }

  function initPickers() {
    var hosts = document.querySelectorAll("#ads-firms-filters .ads-picker");
    hosts.forEach(buildPicker);
    var needs = {};
    Object.keys(PICKERS).forEach(function (k) { needs[PICKERS[k].kind] = true; });
    var jobs = Object.keys(needs).map(function (kind) {
      return loadTaxonomy(kind).then(function (items) {
        Object.keys(PICKERS).forEach(function (k) {
          if (PICKERS[k].kind === kind) PICKERS[k].setItems(items);
        });
      });
    });
    return Promise.all(jobs);
  }

  function hydratePickersFromForm() {
    Object.keys(PICKERS).forEach(function (k) {
      var f = document.getElementById("ads-firms-filters");
      var el = f.elements[k];
      var v = el ? String(el.value || "") : "";
      var slugs = v ? v.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
      PICKERS[k].setSelected(slugs);
    });
  }

  function clearPickers() {
    Object.keys(PICKERS).forEach(function (k) { PICKERS[k].setSelected([]); });
  }

  // Dual-handle slider: builds two range inputs sharing a track. The min/max
  // values are mirrored into the form's hidden inputs so buildQS picks them up.
  function buildDualSliders() {
    document.querySelectorAll(".ads-dual").forEach(function (host) {
      var minName = host.dataset.minName, maxName = host.dataset.maxName;
      var cap = Number(host.dataset.cap || "100000000");
      var step = Number(host.dataset.step || "1000");
      var hMin = host.parentNode.querySelector('input[name="' + minName + '"]');
      var hMax = host.parentNode.querySelector('input[name="' + maxName + '"]');
      var outId = host.parentNode.querySelector("output");
      host.innerHTML =
        '<div class="track"></div><div class="fill"></div>' +
        '<input type="range" min="0" max="' + cap + '" step="' + step + '" value="0" class="lo">' +
        '<input type="range" min="0" max="' + cap + '" step="' + step + '" value="' + cap + '" class="hi">';
      var lo = host.querySelector(".lo"), hi = host.querySelector(".hi"), fill = host.querySelector(".fill");
      function fmt(n) { if (!n) return "$0"; if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k"; return "$" + n; }
      function paint() {
        var l = Number(lo.value), h = Number(hi.value);
        if (l > h) { var t = l; l = h; h = t; lo.value = l; hi.value = h; }
        fill.style.left = (l / cap * 100) + "%";
        fill.style.right = (100 - h / cap * 100) + "%";
        hMin.value = l > 0 ? String(l) : "";
        hMax.value = h < cap ? String(h) : "";
        if (outId) outId.textContent = (l === 0 && h === cap) ? "any" : (fmt(l) + " – " + fmt(h));
      }
      lo.addEventListener("input", paint); hi.addEventListener("input", paint);
      // Initialize from existing query params
      var p = new URLSearchParams(window.location.search);
      if (p.get(minName)) lo.value = p.get(minName);
      if (p.get(maxName)) hi.value = p.get(maxName);
      paint();
    });
  }

  function setupColumnsModal() {
    var modal = document.getElementById("ads-firms-cols-modal");
    document.getElementById("ads-firms-columns").addEventListener("click", function () {
      var list = document.getElementById("ads-firms-cols-list");
      list.innerHTML = ALL_COLS.map(function (c) {
        var checked = state.cols.indexOf(c) !== -1 ? "checked" : "";
        return '<label><input type="checkbox" data-col="' + c + '" ' + checked + '> ' + esc(c) + '</label>';
      }).join("");
      list.querySelectorAll("input").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var col = cb.dataset.col;
          if (cb.checked) { if (state.cols.indexOf(col) === -1) state.cols.push(col); }
          else state.cols = state.cols.filter(function (x) { return x !== col; });
          save("ads_firms_cols", state.cols);
          renderTable();
        });
      });
      modal.hidden = false;
    });
    document.getElementById("ads-firms-cols-close").addEventListener("click", function () { modal.hidden = true; });
    modal.addEventListener("click", function (e) { if (e.target === modal) modal.hidden = true; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    setupColumnsModal();
    buildDualSliders();
    document.getElementById("ads-firms-filters").addEventListener("submit", function (e) {
      e.preventDefault();
      state.nextCursor = null;
      loadResults(false); loadSummary();
    });
    document.getElementById("ads-firms-reset").addEventListener("click", function () {
      var f = document.getElementById("ads-firms-filters"); f.reset();
      // Re-init sliders so handles snap back to extremes
      f.querySelectorAll('input[type="hidden"]').forEach(function (h) { h.value = ""; });
      clearPickers();
      f.querySelectorAll('.ads-dual').forEach(function (host) {
        host.querySelector(".lo").value = 0;
        host.querySelector(".hi").value = host.querySelector(".hi").max;
        host.querySelector(".lo").dispatchEvent(new Event("input"));
      });
      state.nextCursor = null; state.sort_by = "";
      syncURL(new URLSearchParams());
      loadResults(false); loadSummary();
    });
    document.getElementById("ads-firms-loadmore").addEventListener("click", function () { loadResults(true); });
    document.getElementById("ads-firms-save-view").addEventListener("click", function () {
      var name = prompt("Name this view:"); if (!name) return;
      var qs = buildQS(document.getElementById("ads-firms-filters")).toString();
      window.adsUtil.request(API_BASE + "/api/saved-filters", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, entity: "firms", querystring: qs }),
      }).then(loadViews);
    });
    document.getElementById("ads-firms-export").addEventListener("click", function () {
      var qs = buildQS(document.getElementById("ads-firms-filters"));
      var filter = {}; qs.forEach(function (v, k) { filter[k] = v; });
      if (window.adsExport && typeof window.adsExport.openCustom === "function") {
        window.adsExport.openCustom({ entity: "firms", filter: filter });
        return;
      }
      window.adsUtil.request(API_BASE + "/api/exports/csv", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "firms",
          columns: state.cols.filter(function (c) { return c !== "hq"; }).map(function (c) { return { field: c }; }),
          filter: filter, format: "csv",
        }),
      }).then(function (r) { return r.blob(); }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a"); a.href = url; a.download = "firms.csv";
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
      });
    });

    // Load taxonomy first so the URL-driven preselect lands on the right rows.
    initPickers().then(function () {
      readQS();
      hydratePickersFromForm();
      loadResults(false); loadSummary();
    });
    loadViews();
  });
})();
