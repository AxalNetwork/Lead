/* AI Data Signal — Command palette (⌘K / Ctrl-K) + global hotkeys.
 * Indexes nav links, saved filters, recent entities, AI search hits,
 * and quick actions. Opens in <50ms (no network on open). */
(function () {
  var ADS = window.ADS || (window.ADS = {});
  if (ADS.cmdk) return;
  var cmdk = ADS.cmdk = {};
  var API = (window.ADS && window.ADS.API) || (typeof window.API_BASE === "string" ? window.API_BASE : "");

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* ---- Index sources ---- */
  function navItems() {
    var out = [];
    document.querySelectorAll(".ads-rail__link[data-cmdk-nav]").forEach(function (a) {
      out.push({
        id: "nav:" + a.getAttribute("href"),
        group: "Navigate",
        label: a.getAttribute("data-cmdk-nav") || a.textContent.trim(),
        href: a.getAttribute("href")
      });
    });
    return out;
  }
  function quickActions() {
    return [
      { id: "qa:new-project", group: "Quick actions", label: "New project", href: "/dashboard/projects/new/" },
      { id: "qa:import-file", group: "Quick actions", label: "Import file", href: "/dashboard/imports/" },
      { id: "qa:start-crawl", group: "Quick actions", label: "Start a crawl", href: "/dashboard/imports/" },
      { id: "qa:open-errors", group: "Quick actions", label: "Open errors", href: "/dashboard/errors/" },
      { id: "qa:open-jobs", group: "Quick actions", label: "Open jobs", href: "/dashboard/jobs/" },
      { id: "qa:rerun-failed", group: "Quick actions", label: "Re-run failed jobs", href: "/dashboard/jobs/?status=failed" },
      { id: "qa:open-uploads", group: "Quick actions", label: "Past uploads", href: "/dashboard/uploads/" }
    ];
  }
  function recentEntities() {
    try {
      var raw = localStorage.getItem("ads.recent") || "[]";
      var arr = JSON.parse(raw);
      return (arr || []).slice(0, 8).map(function (r, i) {
        return { id: "rec:" + i + ":" + r.href, group: "Recent", label: r.label, href: r.href };
      });
    } catch (e) { return []; }
  }
  cmdk.recordRecent = function (label, href) {
    if (!label || !href) return;
    try {
      var raw = localStorage.getItem("ads.recent") || "[]";
      var arr = JSON.parse(raw) || [];
      arr = arr.filter(function (r) { return r.href !== href; });
      arr.unshift({ label: label, href: href, t: Date.now() });
      localStorage.setItem("ads.recent", JSON.stringify(arr.slice(0, 12)));
    } catch (e) {}
  };
  function savedFiltersCached() {
    try {
      var raw = localStorage.getItem("ads.saved_filters") || "[]";
      return (JSON.parse(raw) || []).map(function (f) {
        return { id: "sf:" + f.id, group: "Saved views", label: f.name, href: f.href || "/dashboard/" };
      });
    } catch (e) { return []; }
  }

  /* ---- Async AI search (only on input >= 2 chars) ---- */
  var lastQ = "", lastReqId = 0, aiCache = {};
  function aiSearch(q, cb) {
    if (!API || !q || q.length < 2) return cb([]);
    if (aiCache[q]) return cb(aiCache[q]);
    var rid = ++lastReqId;
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 1500);
    fetch(API.replace(/\/$/, "") + "/api/search?q=" + encodeURIComponent(q) + "&limit=8", {
      credentials: "include", signal: ctl.signal
    }).then(function (r) { return r.ok ? r.json() : []; })
      .then(function (json) {
        clearTimeout(to);
        if (rid !== lastReqId) return;
        var raw = (json && (json.items || json.results)) || (Array.isArray(json) ? json : []);
        var items = raw.slice(0, 8).map(function (x, i) {
          var label = x.title || x.label || x.name || (x.kind ? x.kind + ":" + (x.id || "") : "Result");
          var href = x.href || x.url || "#";
          return { id: "ai:" + i + ":" + (href || x.id || label),
                   group: "Search results",
                   label: label,
                   subtitle: x.subtitle || "",
                   type: x.type || x.kind || "",
                   type_label: x.type_label || "",
                   href: href };
        });
        aiCache[q] = items;
        cb(items);
      }).catch(function () { clearTimeout(to); cb([]); });
  }

  /* ---- Build pool ---- */
  function buildBase() {
    return [].concat(quickActions(), navItems(), recentEntities(), savedFiltersCached());
  }
  function fuzzy(q, items) {
    if (!q) return items;
    var ql = q.toLowerCase();
    return items
      .map(function (it) {
        var l = (it.label || "").toLowerCase();
        var idx = l.indexOf(ql);
        var score = idx >= 0 ? (1000 - idx) : 0;
        if (score === 0) {
          // letter-by-letter subsequence match
          var i = 0, j = 0; while (i < ql.length && j < l.length) { if (ql[i] === l[j]) i++; j++; }
          if (i === ql.length) score = 100 - (l.length - ql.length);
        }
        return { it: it, score: score };
      })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (x) { return x.it; });
  }

  /* ---- UI ---- */
  var openEl = null, idx = 0, rendered = [], inputEl = null, listEl = null, returnFocus = null;
  cmdk.open = function () {
    if (openEl) return;
    returnFocus = document.activeElement;
    openEl = el("div", "ads-cmdk");
    openEl.setAttribute("role", "dialog");
    openEl.setAttribute("aria-modal", "true");
    openEl.setAttribute("aria-label", "Command palette");
    var panel = el("div", "ads-cmdk__panel");
    inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "ads-cmdk__input";
    inputEl.placeholder = "Type a command, page, or search…";
    inputEl.setAttribute("aria-label", "Command palette query");
    inputEl.setAttribute("autocomplete", "off");
    listEl = el("div", "ads-cmdk__list");
    listEl.setAttribute("role", "listbox");
    var hint = el("div", "ads-cmdk__hint");
    hint.innerHTML = '<span><span class="ads-kbd">↵</span> to open</span>' +
      '<span><span class="ads-kbd">↑</span><span class="ads-kbd">↓</span> to navigate</span>' +
      '<span><span class="ads-kbd">esc</span> to close</span>' +
      '<span><span class="ads-kbd">?</span> shortcuts</span>';
    panel.appendChild(inputEl); panel.appendChild(listEl); panel.appendChild(hint);
    openEl.appendChild(panel);
    document.body.appendChild(openEl);
    inputEl.focus();
    render("");
    inputEl.addEventListener("input", function () { onInput(inputEl.value); });
    inputEl.addEventListener("keydown", onKeydown);
    openEl.addEventListener("click", function (e) { if (e.target === openEl) cmdk.close(); });
  };
  cmdk.close = function () {
    if (!openEl) return;
    openEl.remove(); openEl = null;
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  };
  function render(q) {
    var base = fuzzy(q, buildBase()).slice(0, 24);
    rendered = base; idx = 0;
    listEl.innerHTML = "";
    if (!base.length) {
      var em = el("div", "ads-cmdk__empty", "No matches. Try a different search.");
      listEl.appendChild(em);
    }
    var lastGroup = null;
    base.forEach(function (it, i) {
      if (it.group !== lastGroup) {
        var g = el("div", "ads-cmdk__group", it.group);
        listEl.appendChild(g);
        lastGroup = it.group;
      }
      var row = el("div", "ads-cmdk__item");
      row.setAttribute("role", "option");
      row.setAttribute("data-i", i);
      if (i === 0) row.setAttribute("aria-selected", "true");
      var labelWrap = el("div", "ads-cmdk__item-label");
      labelWrap.appendChild(el("span", null, it.label));
      if (it.type_label) {
        var b = el("span", "ads-cmdk__badge", it.type_label);
        labelWrap.appendChild(b);
      }
      row.appendChild(labelWrap);
      var meta = el("div", "ads-cmdk__item-meta");
      meta.appendChild(el("span", null, it.subtitle || it.href || ""));
      row.appendChild(meta);
      row.addEventListener("mouseenter", function () { setIdx(i); });
      row.addEventListener("click", function () { activate(it); });
      listEl.appendChild(row);
    });
  }
  function setIdx(n) {
    if (n < 0 || n >= rendered.length) return;
    var rows = listEl.querySelectorAll(".ads-cmdk__item");
    rows.forEach(function (r) { r.removeAttribute("aria-selected"); });
    rows[n] && rows[n].setAttribute("aria-selected", "true");
    rows[n] && rows[n].scrollIntoView({ block: "nearest" });
    idx = n;
  }
  function activate(it) {
    cmdk.recordRecent(it.label, it.href);
    cmdk.close();
    if (it.href) window.location.assign(it.href);
  }
  function onInput(q) {
    render(q);
    if (q && q.length >= 2 && q !== lastQ) {
      lastQ = q;
      aiSearch(q, function (items) {
        if (!openEl) return;
        // Append AI hits below existing rendered set.
        var lastGroup = null;
        items.forEach(function (it) {
          if (it.group !== lastGroup) {
            var g = el("div", "ads-cmdk__group", it.group);
            listEl.appendChild(g);
            lastGroup = it.group;
          }
          var i = rendered.length;
          rendered.push(it);
          var row = el("div", "ads-cmdk__item");
          row.setAttribute("role", "option");
          row.setAttribute("data-i", i);
          var labelWrap2 = el("div", "ads-cmdk__item-label");
          labelWrap2.appendChild(el("span", null, it.label));
          if (it.type_label) {
            var b2 = el("span", "ads-cmdk__badge", it.type_label);
            labelWrap2.appendChild(b2);
          }
          row.appendChild(labelWrap2);
          var meta = el("div", "ads-cmdk__item-meta");
          meta.appendChild(el("span", null, it.subtitle || it.href || ""));
          row.appendChild(meta);
          row.addEventListener("mouseenter", function () { setIdx(i); });
          row.addEventListener("click", function () { activate(it); });
          listEl.appendChild(row);
        });
      });
    }
  }
  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); cmdk.close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(Math.min(idx + 1, rendered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setIdx(Math.max(idx - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); rendered[idx] && activate(rendered[idx]); return; }
  }

  /* ---- Hot keys: ⌘K / Ctrl-K, ?, /, [, g i / g c / g p / g x, n p / n i ---- */
  var pendingPrefix = null, pendingTimer = null;
  function clearPrefix() { pendingPrefix = null; if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; } }
  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
  }
  document.addEventListener("keydown", function (e) {
    // ⌘K / Ctrl-K — always intercept
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (openEl) cmdk.close(); else cmdk.open();
      return;
    }
    if (openEl) return; // palette handles its own keys
    if (isTyping(e)) return;
    // ? — shortcuts help
    if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      ADS.ui && ADS.ui.modal({
        title: "Keyboard shortcuts",
        body:
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;font-size:13px">' +
          '<span><span class="ads-kbd">⌘K</span> / <span class="ads-kbd">Ctrl+K</span></span><span>Open command palette</span>' +
          '<span><span class="ads-kbd">/</span></span><span>Focus search</span>' +
          '<span><span class="ads-kbd">[</span></span><span>Toggle sidebar</span>' +
          '<span><span class="ads-kbd">g</span> <span class="ads-kbd">i</span></span><span>Go to Investors</span>' +
          '<span><span class="ads-kbd">g</span> <span class="ads-kbd">c</span></span><span>Go to Companies</span>' +
          '<span><span class="ads-kbd">g</span> <span class="ads-kbd">p</span></span><span>Go to Projects</span>' +
          '<span><span class="ads-kbd">g</span> <span class="ads-kbd">x</span></span><span>Go to Errors</span>' +
          '<span><span class="ads-kbd">n</span> <span class="ads-kbd">p</span></span><span>New project</span>' +
          '<span><span class="ads-kbd">n</span> <span class="ads-kbd">i</span></span><span>New import</span>' +
          '<span><span class="ads-kbd">?</span></span><span>Show this help</span>' +
          '</div>',
        actions: [{ label: "Close", kind: "ghost", onClick: function (close) { close(); } }]
      });
      return;
    }
    // / — focus first search input on page, else open palette
    if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
      var s = document.querySelector('input[type="search"], input[name="q"], input[placeholder*="Search" i]');
      if (s) { e.preventDefault(); s.focus(); s.select && s.select(); return; }
      e.preventDefault(); cmdk.open(); return;
    }
    // [ — toggle sidebar
    if (e.key === "[" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); ADS.ui && ADS.ui.rail.toggle(); return;
    }
    // Two-key combos
    if (pendingPrefix) {
      var dest = null;
      if (pendingPrefix === "g") {
        if (e.key === "i") dest = "/dashboard/investors/";
        else if (e.key === "c") dest = "/dashboard/companies/";
        else if (e.key === "p") dest = "/dashboard/projects/";
        else if (e.key === "x") dest = "/dashboard/errors/";
        else if (e.key === "h") dest = "/dashboard/";
      } else if (pendingPrefix === "n") {
        if (e.key === "p") dest = "/dashboard/projects/new/";
        else if (e.key === "i") dest = "/dashboard/imports/";
      }
      clearPrefix();
      if (dest) { e.preventDefault(); window.location.assign(dest); }
      return;
    }
    if (e.key === "g" || e.key === "n") {
      pendingPrefix = e.key;
      pendingTimer = setTimeout(clearPrefix, 1200);
      return;
    }
  });

  /* ---- Wire trigger button ---- */
  function wire() {
    var btn = document.getElementById("ads-cmdk-trigger");
    btn && btn.addEventListener("click", function () { cmdk.open(); });
    // Record current page in recents
    var t = (document.title || "").split(" — ")[0];
    if (t && location.pathname.indexOf("/dashboard/") === 0) cmdk.recordRecent(t, location.pathname);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
