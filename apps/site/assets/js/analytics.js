(function () {
  var API_BASE = window.ADS_API_BASE;
  function trackEvent(name, props) {
    try {
      navigator.sendBeacon(
        API_BASE + "/api/analytics/event",
        new Blob([JSON.stringify({ name: name, props: props || {}, ts: Date.now(), path: location.pathname })], { type: "application/json" })
      );
    } catch (e) { /* ignore */ }
  }
  document.addEventListener("DOMContentLoaded", function () {
    trackEvent("dashboard_view", { path: location.pathname });
  });
  window.adsTrack = trackEvent;
})();
