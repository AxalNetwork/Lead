// Per-entity "Watch" star. Drop a <button data-ads-watch="<entity_id>">
// anywhere on an entity detail page and this module will:
//   • check DEFAULT-watchlist membership (the toggle target),
//   • render filled/empty star + label accordingly. When the entity
//     also belongs to non-default lists, the button title surfaces
//     them so the operator isn't misled by an "unwatched" star,
//   • on click, POST/DELETE /api/watchlists/watch/:entityId — both
//     operate on the default watchlist (consistent w/ `watching`).
(function () {
  var API = (window.ADS && window.ADS.API) || "";
  function apiUrl(p) { return (API || "") + p; }
  var nodes = document.querySelectorAll("[data-ads-watch]");
  if (!nodes.length) return;

  Array.prototype.forEach.call(nodes, function (btn) {
    var entityId = btn.getAttribute("data-ads-watch");
    if (!entityId) return;
    btn.setAttribute("aria-pressed", "false");
    btn.classList.add("ads-watch-btn");
    btn.innerHTML = '<span class="ads-watch-icon" aria-hidden="true">☆</span><span class="ads-watch-label">Watch</span>';

    function render(state) {
      var on = !!state;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("is-on", on);
      btn.querySelector(".ads-watch-icon").textContent = on ? "★" : "☆";
      btn.querySelector(".ads-watch-label").textContent = on ? "Watching" : "Watch";
    }

    window.adsUtil.request(apiUrl("/api/watchlists/watch/" + encodeURIComponent(entityId)), { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : { watching: false, lists: [] }; })
      .then(function (j) {
        render(!!j.watching);
        var nonDefault = (j.lists || []).filter(function (l) { return !l.is_default; });
        if (nonDefault.length) {
          btn.title = "Also in: " + nonDefault.map(function (l) { return l.name; }).join(", ");
        }
      })
      .catch(function () { render(false); });

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var on = btn.getAttribute("aria-pressed") === "true";
      btn.disabled = true;
      var method = on ? "DELETE" : "POST";
      window.adsUtil.request(apiUrl("/api/watchlists/watch/" + encodeURIComponent(entityId)), {
        method: method, credentials: "include",
      })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function () { render(!on); })
        .catch(function () {})
        .finally(function () { btn.disabled = false; });
    });
  });
})();
