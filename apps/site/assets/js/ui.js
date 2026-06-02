/* AI Data Signal — UI helpers (vanilla JS, no deps).
 * Exposes window.ADS.ui = { toast, modal, confirm, confirmDestructive,
 * scoreBar, theme, kbd }. Loaded on every dashboard page. */
(function () {
  var ADS = window.ADS || (window.ADS = {});
  var ui = ADS.ui = ADS.ui || {};

  /* ---- Theme: auto | light | dark, persisted to localStorage ---- */
  var THEME_KEY = "ads.theme";
  function applyTheme(t) {
    var resolved = t;
    if (t === "auto" || !t) {
      resolved = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", resolved);
    var icon = document.getElementById("ads-theme-icon");
    if (icon) icon.textContent = resolved === "light" ? "☀" : "☾";
  }
  ui.theme = {
    get: function () { return localStorage.getItem(THEME_KEY) || "auto"; },
    set: function (t) { localStorage.setItem(THEME_KEY, t); applyTheme(t); },
    cycle: function () {
      var cur = this.get();
      var next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
      this.set(next);
      ui.toast({ message: "Theme: " + next, kind: "ok", duration: 1400 });
      return next;
    },
    init: function () {
      applyTheme(this.get());
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      try { mq.addEventListener("change", function () { if (ui.theme.get() === "auto") applyTheme("auto"); }); }
      catch (e) { mq.addListener(function () { if (ui.theme.get() === "auto") applyTheme("auto"); }); }
    }
  };

  /* ---- Toast stack (replaces alert) ---- */
  function ensureStack() {
    var s = document.getElementById("ads-toast-stack");
    if (s) return s;
    s = document.createElement("div");
    s.id = "ads-toast-stack";
    s.className = "ads-toast-stack";
    s.setAttribute("aria-live", "polite");
    s.setAttribute("aria-atomic", "false");
    document.body.appendChild(s);
    return s;
  }
  ui.toast = function (opts) {
    if (typeof opts === "string") opts = { message: opts };
    var stack = ensureStack();
    var el = document.createElement("div");
    el.className = "ads-toast" + (opts.kind ? " ads-toast--" + opts.kind : "");
    el.setAttribute("role", opts.kind === "err" ? "alert" : "status");
    var msg = document.createElement("div");
    msg.style.flex = "1";
    msg.textContent = opts.message || "";
    var x = document.createElement("button");
    x.className = "ads-toast__close";
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss notification");
    x.textContent = "×";
    x.addEventListener("click", function () { el.remove(); });
    el.appendChild(msg); el.appendChild(x);
    stack.appendChild(el);
    var dur = typeof opts.duration === "number" ? opts.duration : (opts.kind === "err" ? 6000 : 3500);
    if (dur > 0) setTimeout(function () { el.remove(); }, dur);
    return el;
  };

  /* ---- Modal (focus trap + return focus) ---- */
  function trapFocus(panel, returnTo) {
    var focusables = panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    var first = focusables[0], last = focusables[focusables.length - 1];
    function onKey(e) {
      if (e.key === "Escape") { close(); return; }
      if (e.key !== "Tab" || !focusables.length) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function close() {
      panel.parentElement && panel.parentElement.remove();
      document.removeEventListener("keydown", onKey, true);
      if (returnTo && returnTo.focus) returnTo.focus();
    }
    document.addEventListener("keydown", onKey, true);
    if (first) first.focus();
    return close;
  }
  ui.modal = function (opts) {
    var returnFocus = document.activeElement;
    var root = document.createElement("div");
    root.className = "ads-modal";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "ads-modal-title");
    var panel = document.createElement("div");
    panel.className = "ads-modal__panel";
    var titleEl = document.createElement("h2");
    titleEl.className = "ads-modal__title";
    titleEl.id = "ads-modal-title";
    titleEl.textContent = opts.title || "";
    var bodyEl = document.createElement("div");
    bodyEl.className = "ads-modal__body";
    if (typeof opts.body === "string") bodyEl.innerHTML = opts.body;
    else if (opts.body instanceof Node) bodyEl.appendChild(opts.body);
    var actions = document.createElement("div");
    actions.className = "ads-modal__actions";
    panel.appendChild(titleEl); panel.appendChild(bodyEl); panel.appendChild(actions);
    root.appendChild(panel);
    document.body.appendChild(root);
    var close;
    (opts.actions || [
      { label: "Cancel", kind: "ghost", onClick: function () { close(); } },
      { label: "OK", onClick: function () { close(); } }
    ]).forEach(function (a) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ads-btn" + (a.kind === "ghost" ? " ads-btn--ghost" : (a.kind === "danger" ? " ads-btn--danger" : ""));
      if (a.kind === "danger") b.style.background = "var(--ads-danger)";
      b.textContent = a.label;
      b.addEventListener("click", function () { try { a.onClick && a.onClick(close); } catch (e) { ui.toast({ message: e.message, kind: "err" }); } });
      actions.appendChild(b);
    });
    root.addEventListener("click", function (e) { if (e.target === root) close(); });
    close = trapFocus(panel, returnFocus);
    return { close: function () { close(); } };
  };

  /* ---- Confirm (replaces window.confirm) ---- */
  ui.confirm = function (opts) {
    if (typeof opts === "string") opts = { title: opts };
    return new Promise(function (resolve) {
      ui.modal({
        title: opts.title || "Confirm",
        body: opts.body || "",
        actions: [
          { label: opts.cancelLabel || "Cancel", kind: "ghost", onClick: function (close) { close(); resolve(false); } },
          { label: opts.confirmLabel || "OK", kind: opts.danger ? "danger" : undefined,
            onClick: function (close) { close(); resolve(true); } }
        ]
      });
    });
  };

  /* ---- confirmDestructive: typed confirmation ---- */
  ui.confirmDestructive = function (opts) {
    return new Promise(function (resolve) {
      var wrap = document.createElement("div");
      wrap.innerHTML =
        '<p style="margin:0 0 8px">' + (opts.body || "This action cannot be undone.") + '</p>' +
        '<p style="margin:0 0 6px;font-size:12px;color:var(--ads-muted)">Type <code>' +
        (opts.confirmText || "DELETE") + '</code> to confirm.</p>' +
        '<input type="text" class="ads-input" id="ads-confirm-input" autocomplete="off" ' +
        'style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--ads-border);background:var(--ads-bg);color:var(--ads-text)">';
      var m = ui.modal({
        title: opts.title || "Are you sure?",
        body: wrap,
        actions: [
          { label: "Cancel", kind: "ghost", onClick: function (close) { close(); resolve(false); } },
          { label: opts.confirmLabel || "Delete", kind: "danger", onClick: function (close) {
              var v = (wrap.querySelector("#ads-confirm-input").value || "").trim();
              if (v !== (opts.confirmText || "DELETE")) {
                ui.toast({ message: "Confirmation text doesn't match.", kind: "warn" });
                return;
              }
              close(); resolve(true);
          } }
        ]
      });
      setTimeout(function () { var i = wrap.querySelector("#ads-confirm-input"); i && i.focus(); }, 30);
      return m;
    });
  };

  /* ---- Score bar renderer (universal) ---- */
  function bandFor(n) { if (n < 40) return "low"; if (n < 65) return "mid"; if (n < 85) return "good"; return "great"; }
  ui.scoreBar = function (value, opts) {
    opts = opts || {};
    var n = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    var band = bandFor(n);
    var label = opts.label ? '<span class="ads-muted" style="font-size:11px">' + opts.label + '</span> ' : "";
    var bd = "";
    if (opts.breakdown && opts.breakdown.length) {
      bd = '<div class="ads-score-pop" hidden>' +
        '<div style="font-weight:600;margin-bottom:6px">Score breakdown</div>' +
        opts.breakdown.map(function (b) {
          return '<div style="display:flex;justify-content:space-between;gap:12px"><span>' +
            (b.label || "") + '</span><b>' + (b.value != null ? b.value : "") + '</b></div>';
        }).join("") + '</div>';
    }
    return label + '<span class="ads-score-bar" data-band="' + band + '" tabindex="0" ' +
      'aria-label="Score ' + n + ' of 100, ' + band + '">' +
        '<span class="ads-score-bar__track"><span class="ads-score-bar__fill" style="width:' + n + '%"></span></span>' +
        '<span class="ads-score-bar__num">' + n + '</span>' + bd +
      '</span>';
  };
  // Hover-toggle the breakdown pop (no JS framework).
  document.addEventListener("mouseover", function (e) {
    var b = e.target.closest && e.target.closest(".ads-score-bar");
    if (!b) return;
    var pop = b.querySelector(".ads-score-pop");
    if (pop) pop.hidden = false;
  });
  document.addEventListener("mouseout", function (e) {
    var b = e.target.closest && e.target.closest(".ads-score-bar");
    if (!b) return;
    var pop = b.querySelector(".ads-score-pop");
    if (pop) pop.hidden = true;
  });

  /* ---- Avatar initials helper ---- */
  ui.initials = function (name) {
    if (!name) return "·";
    var parts = String(name).trim().split(/\s+/);
    return ((parts[0] || "").charAt(0) + (parts[1] || "").charAt(0)).toUpperCase() || "·";
  };

  /* ---- Sidebar rail toggle (collapsed | expanded), persisted ---- */
  var RAIL_KEY = "ads.rail";
  function applyRail() {
    var shell = document.querySelector(".ads-shell");
    if (!shell) return;
    var v = localStorage.getItem(RAIL_KEY) || "expanded";
    shell.setAttribute("data-rail", v);
    var t = document.getElementById("ads-rail-toggle");
    if (t) t.setAttribute("aria-expanded", v === "expanded" ? "true" : "false");
  }
  var railEscHandler = null;
  ui.rail = {
    toggle: function () {
      var cur = localStorage.getItem(RAIL_KEY) || "expanded";
      var next = cur === "expanded" ? "collapsed" : "expanded";
      localStorage.setItem(RAIL_KEY, next);
      applyRail();
    },
    openMobile: function () {
      var shell = document.querySelector(".ads-shell");
      if (!shell) return;
      shell.setAttribute("data-rail-mobile", "open");
      document.body.classList.add("ads-no-scroll"); // body-scroll-lock while drawer open
      var t = document.getElementById("ads-rail-toggle");
      if (t) t.setAttribute("aria-expanded", "true");
      var firstLink = shell.querySelector(".ads-rail a, .ads-rail button");
      if (firstLink) { try { firstLink.focus(); } catch (e) {} }
      // Idempotent: clear any prior handler before attaching a fresh one.
      if (railEscHandler) document.removeEventListener("keydown", railEscHandler, true);
      railEscHandler = function (e) { if (e.key === "Escape") ui.rail.closeMobile(); };
      document.addEventListener("keydown", railEscHandler, true);
    },
    closeMobile: function () {
      var shell = document.querySelector(".ads-shell");
      if (shell) shell.removeAttribute("data-rail-mobile");
      document.body.classList.remove("ads-no-scroll");
      if (railEscHandler) {
        document.removeEventListener("keydown", railEscHandler, true);
        railEscHandler = null;
      }
      var t = document.getElementById("ads-rail-toggle");
      if (t) { t.setAttribute("aria-expanded", "false"); try { t.focus(); } catch (e) {} }
    }
  };

  /* ---- Avatar email backfill (Cloudflare Access header is fetched by dashboard.js) ---- */
  ui.setUser = function (email) {
    var av = document.getElementById("ads-user-avatar");
    if (!av) return;
    av.textContent = ui.initials(email || "");
    av.title = (email || "Sign out") + " — click to sign out";
    av.setAttribute("data-user-email", email || "");
  };

  /* ---- Bootstrap on DOM ready ---- */
  function boot() {
    ui.theme.init();
    applyRail();
    var t = document.getElementById("ads-rail-toggle");
    if (t) t.addEventListener("click", function () {
      if (window.innerWidth <= 900) {
        var shell = document.querySelector(".ads-shell");
        if (shell && shell.getAttribute("data-rail-mobile") === "open") ui.rail.closeMobile();
        else ui.rail.openMobile();
      } else { ui.rail.toggle(); }
    });
    var bd = document.getElementById("ads-rail-backdrop");
    bd && bd.addEventListener("click", function () { ui.rail.closeMobile(); });
    // When the viewport grows past the mobile breakpoint (e.g. rotation /
    // window resize), normalize drawer state so the body scroll-lock, the
    // open attribute, and the Escape listener are never left stuck.
    window.addEventListener("resize", function () {
      if (window.innerWidth > 900) {
        var shell = document.querySelector(".ads-shell");
        if ((shell && shell.getAttribute("data-rail-mobile") === "open") ||
            document.body.classList.contains("ads-no-scroll")) {
          ui.rail.closeMobile();
        }
      }
    });
    var th = document.getElementById("ads-theme-toggle");
    th && th.addEventListener("click", function () { ui.theme.cycle(); });
    var nb = document.getElementById("ads-notify-btn");
    nb && nb.addEventListener("click", function () {
      ui.toast({ message: "No new notifications.", duration: 1800 });
    });
    // Backfill avatar from legacy email element if dashboard.js already set it.
    var legacyEmail = document.getElementById("ads-user-email");
    if (legacyEmail) {
      var sync = function () { ui.setUser((legacyEmail.textContent || "").trim()); };
      sync();
      new MutationObserver(sync).observe(legacyEmail, { childList: true, characterData: true, subtree: true });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
