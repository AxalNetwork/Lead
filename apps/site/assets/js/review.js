(function () {
  var API_BASE = "https://api.aidatasignal.com";

  async function api(path, opts) {
    try {
      var res = await fetch(API_BASE + path, Object.assign({ credentials: "include" }, opts || {}));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      console.warn("API failed", path, e);
      return null;
    }
  }

  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]; }); }

  function row(label, primary, candidate) {
    var diff = (primary || "") !== (candidate || "");
    var cls = diff ? "ads-diff" : "";
    return '<tr class="' + cls + '"><td class="ads-diff__label">' + esc(label) + '</td><td>' + esc(primary || "—") + '</td><td>' + esc(candidate || "—") + '</td></tr>';
  }

  function reviewCard(item) {
    var reasons = "";
    try { reasons = (JSON.parse(item.reasons_json) || []).join(", "); } catch (e) { reasons = item.reasons_json || ""; }
    return (
      '<div class="ads-review" data-id="' + esc(item.id) + '">' +
      '  <div class="ads-review__head">' +
      '    <div><strong>Score:</strong> ' + (Math.round(item.score * 100) / 100) + ' &middot; <span class="ads-muted">' + esc(reasons) + '</span></div>' +
      '    <div class="ads-review__actions">' +
      '      <button class="ads-btn" data-action="merge">Merge</button>' +
      '      <button class="ads-btn ads-btn--ghost" data-action="reject">Reject</button>' +
      '      <button class="ads-btn ads-btn--ghost" data-action="skip">Skip 14d</button>' +
      '    </div>' +
      '  </div>' +
      '  <table class="ads-table"><thead><tr><th></th><th>Primary</th><th>Candidate</th></tr></thead><tbody>' +
      row("Name",   item.primary_name,   item.candidate_name) +
      row("Email",  item.primary_email,  item.candidate_email) +
      row("Org",    item.primary_org,    item.candidate_org) +
      row("Source", item.primary_source_url, item.candidate_source_url) +
      '  </tbody></table>' +
      '</div>'
    );
  }

  async function load() {
    var c = document.getElementById("ads-review-list");
    var data = await api("/api/dedupe/review");
    var items = (data && data.items) || [];
    if (!items.length) { c.innerHTML = '<div class="ads-empty">No open review items.</div>'; return; }
    c.innerHTML = items.map(reviewCard).join("");
  }

  document.addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    var card = btn.closest(".ads-review");
    if (!card) return;
    var id = card.getAttribute("data-id");
    var action = btn.getAttribute("data-action");
    btn.disabled = true;
    var ok = false;
    if (action === "merge") {
      ok = !!(await api("/api/dedupe/review/" + id + "/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    } else if (action === "reject") {
      ok = !!(await api("/api/dedupe/review/" + id + "/reject", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    } else if (action === "skip") {
      ok = !!(await api("/api/dedupe/review/" + id + "/reject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skip_days: 14 }) }));
    }
    if (ok) { card.remove(); }
    else { btn.disabled = false; }
  });

  document.addEventListener("DOMContentLoaded", load);
})();
