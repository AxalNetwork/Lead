// Task #13 — Data room categorized index page.
// Uses ?id=<room_id> per Task #4 static-routing constraint.
(function () {
  var API = window.adsApiBase || "https://api.aidatasignal.com";
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmt(s) { return s ? new Date(s).toLocaleString() : "—"; }
  function api(p) {
    return fetch(API + p, { credentials: "include" }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 200)); });
      return r.json();
    });
  }

  function getParam(k) {
    return new URLSearchParams(window.location.search).get(k);
  }

  var id = getParam("id");
  var meta = document.getElementById("room-meta");
  var idx = document.getElementById("room-index");
  if (!id) { meta.textContent = "Missing ?id="; return; }

  api("/api/data-rooms/" + encodeURIComponent(id) + "/index").then(function (j) {
    var r = j.data_room;
    document.getElementById("room-name").textContent = r.name || "Data room";
    document.getElementById("room-sub").textContent =
      "Target entity " + (r.target_entity_id || "—") + " · " + (j.total || 0) + " documents";
    meta.innerHTML =
      '<div>id: <code>' + esc(r.id) + '</code></div>' +
      '<div>description: ' + esc(r.description || "—") + '</div>';

    var groups = j.by_category || {};
    var keys = Object.keys(groups).sort();
    if (!keys.length) {
      idx.innerHTML = '<div class="ads-card" style="margin-top:1rem">No documents in this room yet. Add documents from the <a href="/dashboard/documents/">Documents</a> page.</div>';
      return;
    }
    idx.innerHTML = keys.map(function (cat) {
      var docs = groups[cat] || [];
      var rows = docs.map(function (d) {
        var summary = d.latest_extraction_summary ? esc(JSON.stringify(d.latest_extraction_summary)) : "—";
        return '<tr>' +
          '<td>' + fmt(d.created_at) + '</td>' +
          '<td><strong>' + esc(d.filename) + '</strong></td>' +
          '<td>' + esc(d.detected_kind || "—") + '</td>' +
          '<td>' + (d.classifier_confidence != null ? Number(d.classifier_confidence).toFixed(2) : "—") + '</td>' +
          '<td><code class="ads-mono" style="font-size:.85em">' + summary + '</code></td>' +
          '</tr>';
      }).join("");
      return '<div class="ads-card" style="margin-top:1rem">' +
        '<h2 class="ads-h2">' + esc(cat) + ' <span class="ads-muted">(' + docs.length + ')</span></h2>' +
        '<div class="ads-table-wrap"><table class="ads-table">' +
          '<thead><tr><th>Uploaded</th><th>Filename</th><th>Kind</th><th>Conf.</th><th>Extraction summary</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="5">—</td></tr>') + '</tbody>' +
        '</table></div></div>';
    }).join("");
  }).catch(function (e) {
    meta.textContent = "Failed: " + e.message;
  });
})();
