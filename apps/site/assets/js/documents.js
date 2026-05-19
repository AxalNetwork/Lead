// Task #13 — Document intelligence UI.
(function () {
  var API = window.adsApiBase || "https://api.aidatasignal.com";
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
  function api(path, opts) {
    return fetch(API + path, Object.assign({ credentials: "include" }, opts || {}))
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 200)); });
        return r.json();
      });
  }

  function renderDocs(items, filterKind, filterEntity) {
    var tb = document.querySelector("#docs-table tbody");
    var filtered = items.filter(function (d) {
      if (filterKind && d.detected_kind !== filterKind) return false;
      if (filterEntity && d.target_entity_id !== filterEntity) return false;
      return true;
    });
    if (!filtered.length) { tb.innerHTML = '<tr><td colspan="9">No documents.</td></tr>'; return; }
    tb.innerHTML = filtered.map(function (d) {
      var statusPill = '<span class="ads-pill ads-pill--' + esc(d.extraction_status || "pending") + '">' + esc(d.extraction_status || "pending") + '</span>';
      return '<tr>' +
        '<td>' + fmt(d.created_at) + '</td>' +
        '<td><strong>' + esc(d.filename) + '</strong></td>' +
        '<td>' + esc(d.detected_kind || "—") + '</td>' +
        '<td>' + (d.classifier_confidence != null ? Number(d.classifier_confidence).toFixed(2) : "—") + '</td>' +
        '<td>' + fmtBytes(d.size_bytes) + '</td>' +
        '<td><span class="ads-pill">see detail</span></td>' +
        '<td><code class="ads-mono">' + esc(d.target_entity_id || "—") + '</code></td>' +
        '<td>' + statusPill + '</td>' +
        '<td><button class="ads-btn" data-detail="' + esc(d.id) + '">View</button> ' +
            '<button class="ads-btn" data-delete="' + esc(d.id) + '">Delete</button></td>' +
        '</tr>';
    }).join("");
  }

  function refreshDocs() {
    var k = document.getElementById("filter-kind").value;
    var e = document.getElementById("filter-entity").value;
    api("/api/documents?limit=200")
      .then(function (j) { renderDocs(j.documents || [], k, e); })
      .catch(function (err) {
        document.querySelector("#docs-table tbody").innerHTML =
          '<tr><td colspan="9">Failed: ' + esc(err.message) + '</td></tr>';
      });
  }

  function showDetail(id) {
    var card = document.getElementById("detail-card");
    card.hidden = false;
    document.getElementById("detail-meta").textContent = "Loading…";
    document.getElementById("detail-extractions").innerHTML = "";
    Promise.all([
      api("/api/documents/" + encodeURIComponent(id)),
      api("/api/documents/" + encodeURIComponent(id) + "/extractions"),
    ]).then(function (parts) {
      var d = parts[0].document;
      var exts = parts[1].extractions || [];
      document.getElementById("detail-meta").innerHTML =
        '<div><strong>' + esc(d.filename) + '</strong></div>' +
        '<div>id: <code>' + esc(d.id) + '</code></div>' +
        '<div>kind: ' + esc(d.detected_kind || "—") + ' (conf ' + (d.classifier_confidence != null ? Number(d.classifier_confidence).toFixed(2) : "—") + ')</div>' +
        '<div>size: ' + fmtBytes(d.size_bytes) + ' · pages: ' + esc(d.page_count == null ? "—" : d.page_count) + '</div>' +
        '<div>linked entity: <code>' + esc(d.target_entity_id || "—") + '</code></div>' +
        '<div>allow_raw_text: ' + (d.allow_raw_text ? "<strong>yes</strong>" : "no") + '</div>' +
        '<div>uploaded: ' + fmt(d.created_at) + '</div>';
      document.getElementById("detail-extractions").innerHTML = exts.length ? exts.map(function (x) {
        return '<div class="ads-card" style="margin-top:.5rem">' +
          '<div><strong>' + esc(x.extractor_name) + '</strong> v' + esc(x.extractor_version) +
          ' · confidence ' + Number(x.confidence).toFixed(2) +
          (x.redaction_applied ? ' · <span class="ads-pill ads-pill--ok">PII redacted</span>' : ' · <span class="ads-pill ads-pill--warn">raw</span>') +
          '</div>' +
          (x.warnings && x.warnings.length ? '<div class="ads-mono" style="color:#a60">warnings: ' + esc(x.warnings.join(", ")) + '</div>' : '') +
          '<pre class="ads-mono" style="max-height:240px;overflow:auto;background:#f6f7f9;padding:.5rem;margin-top:.5rem">' +
            esc(JSON.stringify(x.payload, null, 2)) + '</pre>' +
          '</div>';
      }).join("") : '<div class="ads-muted">No extractions.</div>';
    }).catch(function (e) {
      document.getElementById("detail-meta").textContent = "Failed: " + e.message;
    });
  }

  function deleteDoc(id) {
    if (!confirm("Delete this document? This cannot be undone.")) return;
    api("/api/documents/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function () { document.getElementById("detail-card").hidden = true; refreshDocs(); })
      .catch(function (e) { alert("Delete failed: " + e.message); });
  }

  function renderRooms(items) {
    var tb = document.querySelector("#rooms-table tbody");
    if (!items || !items.length) { tb.innerHTML = '<tr><td colspan="5">No rooms.</td></tr>'; return; }
    tb.innerHTML = items.map(function (r) {
      return '<tr>' +
        '<td>' + fmt(r.created_at) + '</td>' +
        '<td><strong>' + esc(r.name) + '</strong></td>' +
        '<td><code class="ads-mono">' + esc(r.target_entity_id || "—") + '</code></td>' +
        '<td>' + (r.document_count != null ? r.document_count : "—") + '</td>' +
        '<td><a class="ads-btn" href="/dashboard/data-rooms/?id=' + encodeURIComponent(r.id) + '">Open</a></td>' +
        '</tr>';
    }).join("");
  }

  function refreshRooms() {
    api("/api/data-rooms")
      .then(function (j) { renderRooms(j.data_rooms || []); })
      .catch(function (e) {
        document.querySelector("#rooms-table tbody").innerHTML =
          '<tr><td colspan="5">Failed: ' + esc(e.message) + '</td></tr>';
      });
  }

  var folderToggle = document.getElementById("upload-folder");
  var fileInput = document.getElementById("upload-file");
  folderToggle.addEventListener("change", function () {
    if (folderToggle.checked) {
      fileInput.setAttribute("webkitdirectory", "");
      fileInput.setAttribute("directory", "");
    } else {
      fileInput.removeAttribute("webkitdirectory");
      fileInput.removeAttribute("directory");
    }
  });

  document.getElementById("upload-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ev.target;
    var msg = document.getElementById("upload-msg");
    var files = Array.from(fileInput.files || []);
    if (!files.length) { msg.textContent = "Choose at least one file."; return; }
    if (files.length > 50) { msg.textContent = "Max 50 files per upload (got " + files.length + ")."; return; }
    var fd = new FormData();
    files.forEach(function (file) { fd.append("file", file); });
    var tgt = f.target_entity_id.value.trim();
    if (tgt) fd.append("target_entity_id", tgt);
    if (f.allow_raw_text.checked) fd.append("allow_raw_text", "1");
    msg.textContent = "Uploading " + files.length + " file" + (files.length > 1 ? "s" : "") + "…";
    fetch(API + "/api/documents/upload", { method: "POST", body: fd, credentials: "include" })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 200)); });
        return r.json();
      })
      .then(function (j) {
        if (j.results) {
          var ok = j.uploaded != null ? j.uploaded : (j.results.filter(function (x) { return x.ok; }).length);
          msg.textContent = "Uploaded " + ok + " / " + j.results.length;
        } else {
          msg.textContent = "Uploaded: " + (j.detected_kind || "ok") + (j.extraction_error ? " (extract error: " + j.extraction_error + ")" : "");
        }
        f.reset();
        refreshDocs();
      })
      .catch(function (e) { msg.textContent = "Failed: " + e.message; });
  });

  document.getElementById("room-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ev.target;
    var body = { name: f.name.value.trim() };
    var tgt = f.target_entity_id.value.trim();
    if (tgt) body.target_entity_id = tgt;
    api("/api/data-rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function () { f.reset(); refreshRooms(); })
      .catch(function (e) { alert("Failed: " + e.message); });
  });

  document.getElementById("refresh-btn").addEventListener("click", refreshDocs);
  document.getElementById("filter-kind").addEventListener("change", refreshDocs);
  document.getElementById("filter-entity").addEventListener("change", refreshDocs);

  document.addEventListener("click", function (ev) {
    var tD = ev.target.closest("[data-detail]");
    if (tD) { showDetail(tD.getAttribute("data-detail")); return; }
    var tX = ev.target.closest("[data-delete]");
    if (tX) { deleteDoc(tX.getAttribute("data-delete")); return; }
  });

  refreshDocs();
  refreshRooms();
})();
