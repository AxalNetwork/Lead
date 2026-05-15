(function () {
  var toggle = document.getElementById("ads-nav-toggle");
  var panel = document.getElementById("ads-nav-panel");
  if (!toggle || !panel) return;

  var lastFocus = null;

  function getFocusable() {
    return panel.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
  }

  function open() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Close navigation menu");
    lastFocus = document.activeElement;
    var focusables = getFocusable();
    if (focusables.length) focusables[0].focus();
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("click", onDocClick, true);
  }

  function close(restoreFocus) {
    if (panel.hidden) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open navigation menu");
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("click", onDocClick, true);
    if (restoreFocus) {
      (lastFocus && lastFocus.focus ? lastFocus : toggle).focus();
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      var focusables = getFocusable();
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function onDocClick(e) {
    if (panel.contains(e.target) || toggle.contains(e.target)) return;
    close(false);
  }

  toggle.addEventListener("click", function () {
    if (panel.hidden) open();
    else close(true);
  });

  panel.addEventListener("click", function (e) {
    var t = e.target;
    while (t && t !== panel) {
      if (t.tagName === "A") {
        close(false);
        return;
      }
      t = t.parentNode;
    }
  });
})();
