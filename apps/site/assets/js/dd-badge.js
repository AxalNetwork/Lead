// Shared risk-badge helper. Decorates rows / detail headers with a small
// red/yellow/green tag pulled from /api/dd/scores/by-ref, linking through
// to the per-entity DD page. No-op when the API returns 401 or when an
// entity has never been scanned.
(function () {
  "use strict";
  var API = (window.ADS && window.ADS.apiBase) || window.ADS_API_BASE;

  function bandClass(b) {
    return ({
      critical: "ads-tag ads-tag--danger",
      high: "ads-tag ads-tag--warn",
      medium: "ads-tag",
      low: "ads-tag ads-tag--ok",
      unknown: "ads-tag ads-tag--muted",
    })[b] || "ads-tag ads-tag--muted";
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }

  function badgeHtml(table, refId, score) {
    // /scores/by-ref LEFT JOINs entity_risk_scores so an entity that exists
    // but has never been scanned still comes back with risk_band/score = null.
    // Treat that as "unscanned" rather than rendering an UNKNOWN badge.
    var scored = !!(score && score.risk_band && score.risk_score != null);
    if (!scored) {
      var href = score && score.entity_id
        ? "/dashboard/dd-entity/?entity=" + score.entity_id
        : "/dashboard/dd-entity/?table=" + encodeURIComponent(table) + "&ref=" + encodeURIComponent(refId);
      return '<a class="ads-tag ads-tag--muted" title="No DD scan yet — click to scan"'
        + ' href="' + href + '"'
        + ' style="font-size:11px;padding:2px 6px;text-decoration:none">DD ·</a>';
    }
    var label = (score.risk_band || "unknown").toUpperCase();
    var num = score.risk_score != null ? Number(score.risk_score).toFixed(0) : "·";
    var url = "/dashboard/dd-entity/?entity=" + score.entity_id;
    var title = "Risk " + label + " (" + num + ") — last scan " + (score.last_scan_at || "n/a");
    return '<a class="' + bandClass(score.risk_band) + '" title="' + esc(title) + '"'
      + ' href="' + url + '" style="font-size:11px;padding:2px 6px;text-decoration:none">'
      + esc(label) + ' ' + esc(num) + '</a>';
  }

  // Decorate every element with data-dd-ref={refId} under `root` for the
  // given `table`. Injects the badge into a `data-dd-slot` element when
  // present, otherwise appends as a child of the data-dd-ref element.
  function decorate(table, root) {
    root = root || document;
    var nodes = root.querySelectorAll('[data-dd-ref]');
    if (!nodes.length) return Promise.resolve({});
    var ids = [];
    var seen = {};
    nodes.forEach(function (n) {
      var v = String(n.getAttribute('data-dd-ref') || '').trim();
      if (v && !seen[v]) { seen[v] = true; ids.push(v); }
    });
    if (!ids.length) return Promise.resolve({});
    var url = API + "/api/dd/scores/by-ref?table=" + encodeURIComponent(table)
      + "&ids=" + encodeURIComponent(ids.join(","));
    return window.adsUtil.request(url, { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : { items: {} }; })
      .catch(function () { return { items: {} }; })
      .then(function (j) {
        var items = (j && j.items) || {};
        nodes.forEach(function (n) {
          var id = String(n.getAttribute('data-dd-ref') || '').trim();
          var slot = n.querySelector('[data-dd-slot]') || n;
          var existing = slot.querySelector('[data-dd-injected]');
          if (existing) existing.remove();
          var span = document.createElement('span');
          span.setAttribute('data-dd-injected', '1');
          span.style.marginLeft = '6px';
          span.innerHTML = badgeHtml(table, id, items[id]);
          slot.appendChild(span);
        });
        return items;
      });
  }

  window.ADS_DDBadge = { decorate: decorate, bandClass: bandClass };
})();
