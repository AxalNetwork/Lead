// Task #13 — Data room reader.
// Side-by-side: left = categorized doc list, center = doc summary + first
// page text, right = structured extraction payload. Per Task #4 static-
// routing constraint, the room id is carried in the ?id= query string.
(function () {
  var API = window.adsApiBase;
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmt(s) { return s ? new Date(s).toLocaleString() : "—"; }
  function fmtBytes(n) {
    if (n == null) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }
  function api(p) {
    return window.adsUtil.request(API + p, { credentials: "include" }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 200)); });
      return r.json();
    });
  }
  function getParam(k) { return new URLSearchParams(window.location.search).get(k); }

  var id = getParam("id");
  var meta = document.getElementById("room-meta");
  var left = document.getElementById("reader-categories");
  var docTitle = document.getElementById("reader-doc-title");
  var docBody = document.getElementById("reader-doc-body");
  var extPane = document.getElementById("reader-extraction");
  if (!id) { meta.textContent = "Missing ?id="; return; }

  function renderExtraction(extractions) {
    if (!extractions || !extractions.length) {
      extPane.innerHTML = '<div class="ads-muted">No extractions for this document.</div>';
      return;
    }
    extPane.innerHTML = extractions.map(function (x) {
      return '<div style="margin-bottom:.75rem">' +
        '<div><strong>' + esc(x.extractor_name) + '</strong> v' + esc(x.extractor_version) + '</div>' +
        '<div>confidence ' + Number(x.confidence).toFixed(2) +
        (x.redaction_applied ? ' · <span class="ads-pill ads-pill--ok">PII redacted</span>' : ' · <span class="ads-pill ads-pill--warn">raw</span>') +
        '</div>' +
        (x.warnings && x.warnings.length ? '<div style="color:#a60">warnings: ' + esc(x.warnings.join(", ")) + '</div>' : '') +
        '<pre style="max-height:380px;overflow:auto;background:#f6f7f9;padding:.5rem;margin-top:.5rem;font-size:.8em">' +
          esc(JSON.stringify(x.payload, null, 2)) + '</pre>' +
        '</div>';
    }).join("");
  }

  function selectDoc(docId, doc) {
    docTitle.classList.remove("ads-muted");
    docTitle.innerHTML =
      '<strong>' + esc(doc.filename) + '</strong>' +
      ' · ' + esc(doc.detected_kind || "—") +
      ' · ' + fmtBytes(doc.size_bytes) +
      ' · uploaded ' + fmt(doc.created_at);
    docBody.innerHTML = '<div class="ads-muted">Loading extraction summary…</div>';
    extPane.innerHTML = '<div class="ads-muted">Loading…</div>';
    Promise.all([
      api("/api/documents/" + encodeURIComponent(docId)),
      api("/api/documents/" + encodeURIComponent(docId) + "/preview"),
    ]).then(function (results) {
      var d = (results[0] && results[0].document) || {};
      var p = results[1] || {};
      var meta =
        '<div class="ads-mono" style="font-size:.85em">' +
          '<div>id: <code>' + esc(d.id) + '</code></div>' +
          '<div>sha256: <code>' + esc(d.sha256 || "—") + '</code></div>' +
          '<div>pages: ' + esc(d.page_count == null ? "—" : d.page_count) + '</div>' +
          '<div>linked entity: <code>' + esc(d.target_entity_id || "—") + '</code></div>' +
          '<div>OCR: ' + esc(d.ocr_status) + ' · extraction: ' + esc(d.extraction_status) + '</div>' +
          '<div>allow_raw_text: ' + (d.allow_raw_text ? '<strong>yes</strong>' : 'no') + '</div>' +
        '</div>';
      var previewText = p.first_page_text || "";
      var previewHeader = '<div style="margin-top:.75rem;display:flex;align-items:center;gap:.5rem">' +
        '<strong>Document preview</strong>' +
        (p.redacted ? '<span class="ads-pill ads-pill--ok">PII redacted</span>' : '<span class="ads-pill ads-pill--warn">raw text</span>') +
        (p.truncated ? '<span class="ads-muted">(first ~4000 chars)</span>' : '') +
        '</div>';
      var previewBody = previewText
        ? '<pre style="white-space:pre-wrap;word-wrap:break-word;background:#f6f7f9;padding:.75rem;margin-top:.25rem;max-height:520px;overflow:auto;font-size:.85em;line-height:1.4">' + esc(previewText) + '</pre>'
        : '<div class="ads-muted" style="margin-top:.25rem">No extractable text (image-only PDF, binary office format, or extraction failed).</div>';
      docBody.innerHTML = meta + previewHeader + previewBody;
    }).catch(function (e) { docBody.innerHTML = '<div>Failed: ' + esc(e.message) + '</div>'; });
    api("/api/documents/" + encodeURIComponent(docId) + "/extractions")
      .then(function (j) { renderExtraction(j.extractions || []); })
      .catch(function (e) { extPane.innerHTML = '<div>Failed: ' + esc(e.message) + '</div>'; });
  }

  function renderLeft(groups) {
    var keys = Object.keys(groups).sort();
    if (!keys.length) {
      left.innerHTML = '<div class="ads-muted">No documents in this room.</div>';
      return;
    }
    left.innerHTML = keys.map(function (cat) {
      var docs = groups[cat] || [];
      return '<div style="margin-bottom:.75rem">' +
        '<div style="font-weight:600;margin-bottom:.25rem">' + esc(cat) + ' <span class="ads-muted">(' + docs.length + ')</span></div>' +
        '<ul style="list-style:none;padding:0;margin:0">' +
          docs.map(function (d) {
            return '<li style="margin:.15rem 0">' +
              '<a href="#" data-doc="' + esc(d.id) + '" style="text-decoration:none">' +
              esc(d.filename) +
              '</a>' +
              '<div style="font-size:.75em;color:#888">' + esc(d.detected_kind || "—") + ' · ' + fmt(d.created_at) + '</div>' +
              '</li>';
          }).join("") +
        '</ul></div>';
    }).join("");
  }

  api("/api/data-rooms/" + encodeURIComponent(id) + "/index").then(function (j) {
    var r = j.data_room;
    document.getElementById("room-name").textContent = r.name || "Data room";
    document.getElementById("room-sub").textContent =
      "Target entity " + (r.target_entity_id || "—") + " · " + (j.total || 0) + " documents";
    meta.innerHTML =
      '<div>id: <code>' + esc(r.id) + '</code></div>' +
      '<div>description: ' + esc(r.description || "—") + '</div>';

    var groups = j.by_category || {};
    var docsById = {};
    Object.keys(groups).forEach(function (k) {
      (groups[k] || []).forEach(function (d) { docsById[d.id] = d; });
    });
    renderLeft(groups);

    left.addEventListener("click", function (ev) {
      var a = ev.target.closest("[data-doc]");
      if (!a) return;
      ev.preventDefault();
      var did = a.getAttribute("data-doc");
      selectDoc(did, docsById[did] || {});
    });

    var first = Object.keys(groups).sort().map(function (k) { return groups[k]; }).find(function (g) { return g && g.length; });
    if (first && first[0]) selectDoc(first[0].id, first[0]);
  }).catch(function (e) {
    meta.textContent = "Failed: " + e.message;
  });
})();
