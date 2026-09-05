// Mobile UI behaviour — Turn 2 of the design canvas.
//
// Four jobs:
//   1. The "More" sheet (open/close, focus trap, filter).
//   2. The generic table→card labeller. Lists are built as <table
//      class="ads-table"> by ~40 different page scripts; rather than
//      rewriting each, this stamps every cell with its column header as
//      `data-label`, and mobile.css restyles the SAME markup as a card.
//      A MutationObserver covers tables rendered after load, which is all
//      of them.
//   3. Tab badges for Review and Alerts.
//   4. Filling the detail-page breadcrumb with the entity name.
//
// 1–3 are no-ops on desktop; 4 runs at every width, since the breadcrumb
// itself does.
//
// Every network call goes through window.adsUtil.request — Cloudflare
// Access rejects CORS preflights, so a bare fetch() would fail in prod. It
// also defaults credentials to "include", which the Access cookie needs.
(function () {
  "use strict";

  var MOBILE = "(max-width: 767px)";
  function isMobile() {
    return window.matchMedia && window.matchMedia(MOBILE).matches;
  }

  // ---------------------------------------------------------- More sheet --
  (function moreSheet() {
    var openBtn = document.getElementById("ads-more-open");
    var sheet = document.getElementById("ads-more-sheet");
    var backdrop = document.getElementById("ads-more-backdrop");
    var closeBtn = document.getElementById("ads-more-close");
    var search = document.getElementById("ads-more-search");
    if (!openBtn || !sheet || !backdrop) return;

    var lastFocus = null;

    function open() {
      lastFocus = document.activeElement;
      sheet.hidden = false;
      backdrop.hidden = false;
      // Next frame so the transition runs from the translated state.
      requestAnimationFrame(function () {
        sheet.setAttribute("data-open", "true");
        backdrop.setAttribute("data-open", "true");
      });
      openBtn.setAttribute("aria-expanded", "true");
      document.body.classList.add("ads-no-scroll");
      if (search) search.focus();
    }

    function close() {
      sheet.removeAttribute("data-open");
      backdrop.removeAttribute("data-open");
      openBtn.setAttribute("aria-expanded", "false");
      document.body.classList.remove("ads-no-scroll");
      // Wait out the transition before hiding, so it animates.
      window.setTimeout(function () {
        sheet.hidden = true;
        backdrop.hidden = true;
      }, 200);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    openBtn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !sheet.hidden) close();
    });

    // Keep focus inside the sheet while it is open.
    sheet.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var items = sheet.querySelectorAll('a[href], button, input, [tabindex]:not([tabindex="-1"])');
      var list = Array.prototype.filter.call(items, function (el) { return el.offsetParent !== null; });
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // Filter. 30+ destinations is past the point where scanning works.
    if (search) {
      search.addEventListener("input", function () {
        var q = search.value.trim().toLowerCase();
        var groups = sheet.querySelectorAll(".ads-sheet__group");
        var anyShown = false;
        Array.prototype.forEach.call(groups, function (g) {
          var links = g.querySelectorAll(".ads-sheet__link");
          var shown = 0;
          Array.prototype.forEach.call(links, function (a) {
            var hit = !q || a.textContent.toLowerCase().indexOf(q) >= 0;
            a.hidden = !hit;
            if (hit) shown++;
          });
          g.hidden = shown === 0;
          if (shown) anyShown = true;
        });
        var empty = document.getElementById("ads-more-empty");
        if (empty) empty.hidden = anyShown;
      });
    }
  })();

  // ------------------------------------------------- Search tab → palette --
  (function searchTab() {
    var el = document.querySelector('[data-ads-tab="search"]');
    if (!el) return;
    el.addEventListener("click", function (e) {
      // cmdk.js owns the palette. If it is present, open it rather than
      // navigating; otherwise the href (People list) stands as the fallback.
      var ADS = window.ADS;
      var openPalette = ADS && ADS.cmdk && ADS.cmdk.open;
      if (typeof openPalette === "function") {
        e.preventDefault();
        openPalette();
      }
    });
  })();

  // ------------------------------------------------ table → card labeller --
  // Stamps each <td> with its column header text so mobile.css can render
  // the row as a card. Idempotent, and cheap enough to re-run on mutation.
  function labelTable(table) {
    if (!table || !table.tHead) return;
    var headRow = table.tHead.rows[0];
    if (!headRow) return;
    var heads = Array.prototype.map.call(headRow.cells, function (th) {
      // Strip sort indicators (▲/▼) the list pages append.
      return (th.textContent || "").replace(/[▲▼]/g, "").trim();
    });
    if (!heads.length) return;
    var body = table.tBodies[0];
    if (!body) return;
    Array.prototype.forEach.call(body.rows, function (tr) {
      Array.prototype.forEach.call(tr.cells, function (td, i) {
        var label = heads[i];
        if (label && td.getAttribute("data-label") !== label) {
          td.setAttribute("data-label", label);
        }
        // An em-dash / empty cell adds nothing to a card.
        var txt = (td.textContent || "").trim();
        if (txt === "" || txt === "—") td.setAttribute("data-empty", "true");
        else if (td.hasAttribute("data-empty")) td.removeAttribute("data-empty");
      });
    });
  }

  // ---------------------------------------------------------------- crumb --
  // components/crumb.html seeds the trailing label with the page title so the
  // trail never renders a dangling separator. Once the page has fetched its
  // entity, swap in the real name. Detail pages render their <h1> from an
  // async fetch, so this rides the same observer as the labeller.
  function syncCrumb() {
    var here = document.getElementById("ads-crumb-here");
    if (!here) return;
    var h1 = document.querySelector(".ads-main h1");
    if (!h1) return;
    var t = (h1.textContent || "").trim();
    // "—" is the placeholder every detail template ships with.
    if (!t || t === "—") return;
    if (here.textContent !== t) here.textContent = t;
  }

  function labelAll() {
    if (!isMobile()) return;
    var tables = document.querySelectorAll("table.ads-table");
    Array.prototype.forEach.call(tables, labelTable);
  }

  // Tables (and detail-page headings) are rendered asynchronously after their
  // fetch resolves, so watch for them rather than acting once at load.
  function watchTables() {
    if (!window.MutationObserver) return;
    var pending = null;
    var obs = new MutationObserver(function () {
      // Coalesce bursts — a re-render touches many nodes at once.
      if (pending) return;
      pending = window.setTimeout(function () {
        pending = null;
        labelAll();
        syncCrumb();
      }, 50);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    labelAll();
    syncCrumb();
    watchTables();
    // Re-label when crossing the breakpoint (labels are harmless on desktop,
    // but a rotate into mobile should not wait for the next render).
    if (window.matchMedia) {
      var mq = window.matchMedia(MOBILE);
      var onChange = function () { labelAll(); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  // ------------------------------------------------------- tab badges -----
  // Alerts uses /api/alerts/unread-count, which returns { unread }.
  //
  // Review counts the MERGE queue only. The design's Review tab spans four
  // queues, but there is no count endpoint for any of them: /api/dedupe/review
  // returns rows, not a total. Summing four list calls on every page load is
  // too much for a phone, so the badge reports the tab's primary destination
  // and stays honest about it rather than showing a number it cannot get.
  //
  // Both degrade to no badge on any failure: a wrong count is worse than none.
  function setBadge(id, n) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!n || n < 1) { el.hidden = true; return; }
    el.textContent = n > 99 ? "99+" : String(n);
    el.hidden = false;
  }

  function loadBadges() {
    if (!isMobile()) return;
    var util = window.adsUtil;
    var base = window.ADS_API_BASE;
    if (!util || !util.request || !base) return;

    // limit=100 bounds the response; setBadge renders anything above 99 as
    // "99+", so the cap and the display agree.
    util.request(base + "/api/dedupe/review?status=open&limit=100")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.items)) return;
        setBadge("ads-tab-review-badge", j.items.length);
      })
      .catch(function () { /* no badge */ });

    util.request(base + "/api/alerts/unread-count")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || typeof j.unread !== "number") return;
        setBadge("ads-tab-alerts-badge", j.unread);
      })
      .catch(function () { /* no badge */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { init(); loadBadges(); });
  } else {
    init();
    loadBadges();
  }
})();
