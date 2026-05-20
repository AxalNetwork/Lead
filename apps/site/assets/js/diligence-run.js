// Task #6 — Diligence run detail page.
// Per Task #4 static-routing constraint, the run id is carried in ?id=.
(function () {
  var API = (window.ADS && window.ADS.API) || "https://api.aidatasignal.com";
  var OPTS = { credentials: "include" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function safeHref(u) {
    try { var p = new URL(u, location.href); return p.protocol === "https:" || p.protocol === "http:"; }
    catch (e) { return false; }
  }
  function api(path, opts) {
    return fetch(API + path, Object.assign({}, OPTS, opts || {})).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 200)); });
      return r.json();
    });
  }
  function getParam(k) { return new URLSearchParams(location.search).get(k); }

  var STATUS_COLOR = { pass: "#1f7a4d", fail: "#c0392b", caution: "#b87a00", "n/a": "#666", needs_human: "#5b5fa5" };
  var STATUS_GLYPH = { pass: "✓", fail: "✗", caution: "⚠", "n/a": "—", needs_human: "?" };

  var id = getParam("id");
  var titleEl = document.getElementById("d-title");
  var subEl = document.getElementById("d-sub");
  var sectionsEl = document.getElementById("d-sections");
  var bar = document.getElementById("d-progress-bar");
  var barLabel = document.getElementById("d-progress-label");
  var barScore = document.getElementById("d-progress-score");
  var tallyEl = document.getElementById("d-tally");
  var btnRerun = document.getElementById("d-rerun");
  var lnkMd = document.getElementById("d-export-md");
  var lnkJson = document.getElementById("d-export-json");
  var lnkPdf = document.getElementById("d-export-pdf");

  if (!id) {
    subEl.textContent = "Missing ?id=";
    sectionsEl.innerHTML = '<div class="ads-card">Pass <code>?id=&lt;run_id&gt;</code>.</div>';
    return;
  }

  function setHeader(run) {
    titleEl.textContent = "Diligence run · " + run.id.slice(0, 8) + "…";
    subEl.innerHTML = "Target <code>" + esc(run.target_entity_id) + "</code> · template <code>" +
      esc(run.template_id) + "</code> · triggered by " + esc(run.triggered_by) +
      (run.parent_run_id ? " · re-run of <code>" + esc(run.parent_run_id.slice(0, 8)) + "…</code>" : "");
  }

  function setProgress(run) {
    var pct = run.checks_total ? Math.round((run.checks_completed / run.checks_total) * 100) : 0;
    bar.style.width = pct + "%";
    barLabel.textContent = run.checks_completed + "/" + run.checks_total + " checks · status " + run.status;
    barScore.textContent = run.overall_score == null ? "—" : "score " + Number(run.overall_score).toFixed(1) + " / 100";
    var by = run.by_status || {};
    tallyEl.innerHTML =
      'pass <strong style="color:' + STATUS_COLOR.pass + '">' + (by.pass || 0) + '</strong> · ' +
      'fail <strong style="color:' + STATUS_COLOR.fail + '">' + (by.fail || 0) + '</strong> · ' +
      'caution <strong style="color:' + STATUS_COLOR.caution + '">' + (by.caution || 0) + '</strong> · ' +
      'n/a <strong style="color:' + STATUS_COLOR["n/a"] + '">' + (by["n/a"] || 0) + '</strong> · ' +
      'needs_human <strong style="color:' + STATUS_COLOR.needs_human + '">' + (by.needs_human || 0) + '</strong>';
  }

  function renderCard(result) {
    var color = STATUS_COLOR[result.status] || "#666";
    var glyph = STATUS_GLYPH[result.status] || "?";
    var evidence = (result.evidence || []).filter(safeHref).map(function (u) {
      return '<li><a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + '</a></li>';
    }).join("");
    var detailsId = "d-c-" + result.id;
    var flagged = result.flagged_for_human ? "checked" : "";
    return '<details id="' + esc(detailsId) + '" class="ads-card" style="margin-bottom:6px">' +
      '<summary style="cursor:pointer;display:flex;gap:8px;align-items:center">' +
        '<span style="color:' + color + ';font-weight:700;font-size:16px;width:18px">' + glyph + '</span>' +
        '<strong style="flex:1">' + esc(result.title) + '</strong>' +
        '<span style="font-size:11px;color:#888">' + esc(result.severity) + ' · conf ' + Number(result.confidence).toFixed(2) + '</span>' +
      '</summary>' +
      '<div style="margin-top:8px">' +
        '<div style="font-size:11px;color:#888;margin-bottom:4px">key <code>' + esc(result.check_key) + '</code></div>' +
        '<div class="ads-mono" style="white-space:pre-wrap">' + esc(result.finding_md) + '</div>' +
        (evidence ? '<div style="margin-top:8px"><div style="font-size:12px;color:#666">Evidence</div><ul style="margin:.25rem 0 .25rem 1rem">' + evidence + '</ul></div>' : '') +
        '<div style="margin-top:8px"><label style="font-size:12px"><input type="checkbox" data-flag="' + esc(result.id) + '" ' + flagged + '> Flag for human review</label></div>' +
      '</div>' +
    '</details>';
  }

  function renderSections(results) {
    var SECTIONS = ["corporate", "founders", "market", "product", "traction", "team", "regulatory", "financial", "ip"];
    var html = SECTIONS.map(function (s) {
      var rs = results.filter(function (r) { return r.section === s; });
      if (!rs.length) return "";
      return '<div class="ads-card" style="margin-bottom:14px">' +
        '<h2 class="ads-h2" style="margin-top:0;text-transform:capitalize">' + esc(s) + ' <span style="font-size:12px;color:#888">(' + rs.length + ')</span></h2>' +
        rs.map(renderCard).join("") +
        '</div>';
    }).join("");
    sectionsEl.innerHTML = html || '<div class="ads-card">No results yet.</div>';

    sectionsEl.querySelectorAll("input[type=checkbox][data-flag]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var rid = cb.getAttribute("data-flag");
        api("/api/diligence/runs/" + encodeURIComponent(id) + "/results/" + encodeURIComponent(rid), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flagged_for_human: cb.checked }),
        }).catch(function (e) { console.warn(e); cb.checked = !cb.checked; });
      });
    });
  }

  function showExports(run) {
    var base = API + "/api/diligence/runs/" + encodeURIComponent(id);
    // Exports + re-run only make sense once the run has results to act on.
    var done = run && run.status === "completed";
    lnkMd.href = base + "/report.md"; lnkMd.style.display = done ? "" : "none";
    lnkJson.href = base + "/report.json"; lnkJson.style.display = done ? "" : "none";
    lnkPdf.href = base + "/report.pdf"; lnkPdf.style.display = done ? "" : "none";
    btnRerun.style.display = done ? "" : "none";
  }

  var POLL_MS = 1500;
  var pollTimer = null;

  function tick() {
    return api("/api/diligence/runs/" + encodeURIComponent(id)).then(function (body) {
      setHeader(body.run);
      setProgress(body.run);
      renderSections(body.results || []);
      showExports(body.run);
      // Keep polling while the run is still in flight; stop on terminal states.
      var live = body.run && (body.run.status === "queued" || body.run.status === "running");
      if (live) {
        pollTimer = setTimeout(tick, POLL_MS);
      }
    }).catch(function (e) {
      subEl.textContent = "Failed: " + e.message;
    });
  }

  btnRerun.addEventListener("click", function () {
    btnRerun.disabled = true;
    api("/api/diligence/runs/" + encodeURIComponent(id) + "/rerun-failed", { method: "POST" })
      .then(function (summary) { location.href = "/dashboard/diligence/run/?id=" + encodeURIComponent(summary.run_id); })
      .catch(function (e) { alert("Re-run failed: " + e.message); btnRerun.disabled = false; });
  });

  window.addEventListener("beforeunload", function () { if (pollTimer) clearTimeout(pollTimer); });

  tick();
})();
