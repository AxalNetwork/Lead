// Topbar bell — polls /api/alerts/unread-count, renders dropdown of
// recent events on click. Keeps the badge tiny: the actual feed lives
// at /dashboard/alerts.html.
(function () {
  var API = (window.ADS && window.ADS.API) || "";
  var btn = document.getElementById("ads-notify-btn");
  var badge = document.getElementById("ads-notify-badge");
  var drop = document.getElementById("ads-notify-dropdown");
  var list = document.getElementById("ads-notify-list");
  var readAll = document.getElementById("ads-notify-readall");
  if (!btn || !drop || !list) return;

  function apiUrl(p) { return (API || "") + p; }

  function fetchUnread() {
    return fetch(apiUrl("/api/alerts/unread-count"), { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : { unread: 0 }; })
      .catch(function () { return { unread: 0 }; });
  }

  function setBadge(n) {
    if (!badge) return;
    if (!n) { badge.hidden = true; badge.textContent = ""; }
    else { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  }

  function renderItems(items) {
    if (!items.length) {
      list.innerHTML = '<li class="ads-notify-empty">No recent alerts.</li>';
      list.setAttribute("aria-busy", "false");
      return;
    }
    list.innerHTML = items.map(function (it) {
      var unread = !it.read_at;
      var entityHref = it.entity_id
        ? "/dashboard/profile/?entity=" + encodeURIComponent(it.entity_id)
        : "/dashboard/alerts.html";
      return '<li class="ads-notify-item' + (unread ? " is-unread" : "") + '">'
        + '<a href="' + entityHref + '" data-event-id="' + it.id + '">'
        + '<div class="ads-notify-item__title">' + escapeHtml(it.title || "(alert)") + '</div>'
        + '<div class="ads-notify-item__meta">' + escapeHtml(it.trigger_kind || "") + ' · ' + escapeHtml(it.occurred_at || "") + '</div>'
        + '</a></li>';
    }).join("");
    list.setAttribute("aria-busy", "false");
  }

  function openDropdown() {
    drop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    list.innerHTML = '<li class="ads-notify-empty">Loading…</li>';
    list.setAttribute("aria-busy", "true");
    fetch(apiUrl("/api/alerts/events?limit=20"), { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (j) { renderItems(j.items || []); })
      .catch(function () { renderItems([]); });
  }

  function closeDropdown() {
    drop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }

  btn.addEventListener("click", function (e) {
    e.preventDefault();
    if (drop.hidden) openDropdown(); else closeDropdown();
  });

  document.addEventListener("click", function (e) {
    if (drop.hidden) return;
    var t = e.target;
    if (t === btn || btn.contains(t) || drop.contains(t)) return;
    closeDropdown();
  });

  if (readAll) {
    readAll.addEventListener("click", function (e) {
      e.preventDefault();
      fetch(apiUrl("/api/alerts/events/read-all"), { method: "POST", credentials: "include" })
        .then(function () { setBadge(0); openDropdown(); })
        .catch(function () {});
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function tick() { fetchUnread().then(function (r) { setBadge(Number(r.unread) || 0); }); }
  tick();
  setInterval(tick, 60_000);
})();
