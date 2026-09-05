(function () {
  var API_BASE = window.ADS_API_BASE;
  function trackEvent(name, props) {
    try {
      // A JSON Blob via sendBeacon is a non-simple request (preflight), which
      // Cloudflare Access rejects. A keepalive POST through adsUtil.request is
      // a simple request and still survives page navigation.
      window.adsUtil.request(API_BASE + "/api/analytics/event", {
        method: "POST",
        keepalive: true,
        body: JSON.stringify({ name: name, props: props || {}, ts: Date.now(), path: location.pathname }),
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }
  document.addEventListener("DOMContentLoaded", function () {
    trackEvent("dashboard_view", { path: location.pathname });
  });
  window.adsTrack = trackEvent;
})();
