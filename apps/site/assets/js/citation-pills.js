// Task #2: Citation pills + verified badges + dispute view.
//
// Decorates any element with data-fact-id="…" by:
//   1. Fetching /api/facts/:id/citations once per fact id.
//   2. Appending a small "(N)" superscript pill that opens a popover
//      listing each citation (reputability badge + source + quote + Open link).
//   3. Drawing a verified-status icon:
//        verified_score >= 0.7  → green ✓
//        verified_score <  0.3  → yellow ⚠
//        contradicting >  0     → red ⚑ (opens dispute view)
//
// Usage in any detail page:
//   <span class="ads-fact" data-fact-id="…">Andreessen Horowitz</span>
//   <script src="/assets/js/citation-pills.js"></script>

(function () {
  if (window.ADS && window.ADS.CitationPills) return;
  window.ADS = window.ADS || {};

  var API = (window.ADS_API_BASE || "https://api.aidatasignal.com").replace(/\/+$/, "");
  var cache = new Map();
  var popoverEl = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function fetchFact(factId) {
    if (cache.has(factId)) return cache.get(factId);
    var p = fetch(API + "/api/facts/" + encodeURIComponent(factId) + "/citations", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    cache.set(factId, p);
    return p;
  }

  function repTier(s) {
    return s >= 0.9 ? "primary" : s >= 0.8 ? "major" : s >= 0.6 ? "mid" : s >= 0.4 ? "blog" : "low";
  }

  function repColor(s) {
    return s >= 0.9 ? "#1a7a35" : s >= 0.8 ? "#2c6eb5" : s >= 0.6 ? "#7a5a00" : s >= 0.4 ? "#8a4a00" : "#7a1a1a";
  }

  function closePopover() {
    if (popoverEl) { popoverEl.remove(); popoverEl = null; }
    document.removeEventListener("click", onDocClick, true);
  }

  function onDocClick(e) {
    if (popoverEl && !popoverEl.contains(e.target)) closePopover();
  }

  function openPopover(anchor, data, opts) {
    closePopover();
    var d = document.createElement("div");
    d.className = "ads-citation-popover";
    d.style.cssText = "position:absolute;z-index:9999;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.12);padding:10px;max-width:420px;font-size:12px;color:#222";
    var html = "";
    var f = data.fact || {};
    var verified = Number(f.verified_score || 0);
    var contradicting = (data.citations || []).filter(function (c) { return c.contradicts === 1; }).length;
    var badge = verified >= 0.7
      ? '<span style="color:#1a7a35;font-weight:600">✓ verified ' + verified.toFixed(2) + "</span>"
      : verified < 0.3
        ? '<span style="color:#a36a00;font-weight:600">⚠ unverified ' + verified.toFixed(2) + "</span>"
        : '<span style="color:#666">verified ' + verified.toFixed(2) + "</span>";
    html += '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><strong>' + esc(f.predicate) + '</strong>' + badge + "</div>";
    html += '<div style="margin-bottom:6px;color:#444">' + esc(f.value_text || f.value_number || "") + "</div>";
    if (contradicting > 0) {
      html += '<div style="margin-bottom:8px;padding:6px;background:#fff0f0;border-left:3px solid #a33;color:#7a1a1a;font-weight:600">⚑ ' + contradicting + ' contradicting citation(s). <a href="#" class="ads-dispute-open">Open dispute view</a></div>';
    }
    var cits = data.citations || [];
    if (cits.length === 0) {
      html += '<div style="color:#888">No citations yet.</div>';
    } else {
      html += '<ul style="list-style:none;padding:0;margin:0">';
      cits.slice(0, 12).forEach(function (c) {
        var rep = Number(c.source_reputability || 0);
        html +=
          '<li style="margin-bottom:6px;padding:6px;border-radius:4px;background:' + (c.contradicts ? "#fff5f5" : "#f6f8fa") + '">' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<span style="font-size:10px;font-weight:600;color:' + repColor(rep) + '">' + repTier(rep).toUpperCase() + " " + rep.toFixed(2) + "</span>" +
              '<span style="color:#444">' + esc(c.source_name || c.host) + "</span>" +
              (c.contradicts ? '<span style="margin-left:auto;color:#a33;font-weight:600">contradicts</span>' : "") +
            "</div>" +
            (c.quote ? '<div style="margin-top:3px;color:#222">"' + esc(c.quote.slice(0, 240)) + '"</div>' : "") +
            '<div style="margin-top:3px"><a href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer">Open</a>' +
              (c.archive_url ? ' · <a href="' + esc(c.archive_url) + '" target="_blank" rel="noopener noreferrer">Archive</a>' : "") +
            "</div>" +
          "</li>";
      });
      html += "</ul>";
    }
    d.innerHTML = html;
    var rect = anchor.getBoundingClientRect();
    d.style.left = (rect.left + window.scrollX) + "px";
    d.style.top = (rect.bottom + window.scrollY + 4) + "px";
    document.body.appendChild(d);
    popoverEl = d;
    setTimeout(function () { document.addEventListener("click", onDocClick, true); }, 0);
    var disp = d.querySelector(".ads-dispute-open");
    if (disp) disp.addEventListener("click", function (e) {
      e.preventDefault();
      openDisputeView(data, opts);
    });
  }

  function openDisputeView(data, opts) {
    closePopover();
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center";
    var panel = document.createElement("div");
    panel.style.cssText = "background:#fff;border-radius:8px;padding:18px;max-width:760px;width:90%;max-height:80vh;overflow:auto;font-size:13px";
    var f = data.fact || {};
    var competing = data.competing_facts || [];
    var contraCits = (data.citations || []).filter(function (c) { return c.contradicts === 1; });
    var html = '<h3 style="margin:0 0 12px">Dispute: <code>' + esc(f.predicate) + "</code></h3>";
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
    // Left: current fact
    html += '<div style="border:1px solid #1a7a35;border-radius:6px;padding:10px;background:#f0f9f0">' +
            '<div style="font-size:11px;color:#1a7a35;font-weight:700;text-transform:uppercase">Current</div>' +
            '<div style="font-size:16px;margin:6px 0"><strong>' + esc(f.value_text || f.value_number || "") + "</strong></div>" +
            '<div style="font-size:11px;color:#666">source: ' + esc(f.source_kind) + ' · verified ' + Number(f.verified_score || 0).toFixed(2) + "</div>" +
            '<button class="ads-btn ads-mark-canonical" data-fact-id="' + esc(f.id) + '" data-competing="" style="margin-top:8px;font-size:11px">Keep as canonical</button>' +
            "</div>";
    // Right: each competing fact
    competing.forEach(function (cf) {
      html += '<div style="border:1px solid #ccc;border-radius:6px;padding:10px;background:#fafafa">' +
              '<div style="font-size:11px;color:#666;font-weight:700;text-transform:uppercase">Competing</div>' +
              '<div style="font-size:16px;margin:6px 0"><strong>' + esc(cf.value_text || cf.value_number || "") + "</strong></div>" +
              '<div style="font-size:11px;color:#666">source: ' + esc(cf.source_kind) + ' · verified ' + Number(cf.verified_score || 0).toFixed(2) + "</div>" +
              '<button class="ads-btn ads-mark-canonical" data-fact-id="' + esc(cf.id) + '" data-competing="' + esc(f.id) + '" style="margin-top:8px;font-size:11px">Mark as canonical</button>' +
              "</div>";
    });
    html += "</div>";
    html += '<h4 style="margin:18px 0 6px">Contradicting citations</h4>';
    html += '<ul style="list-style:none;padding:0;margin:0">';
    contraCits.forEach(function (c) {
      html += '<li style="margin-bottom:6px;padding:6px;border-radius:4px;background:#fff5f5">' +
        '<div><strong>' + esc(c.source_name || c.host) + "</strong> · " + Number(c.source_reputability || 0).toFixed(2) + "</div>" +
        (c.quote ? '<div style="color:#222;margin-top:2px">"' + esc(c.quote) + '"</div>' : "") +
        '<a href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer">Open</a></li>';
    });
    html += "</ul>";
    html += '<div style="margin-top:14px;text-align:right"><button class="ads-btn ads-dispute-close">Close</button></div>';
    panel.innerHTML = html;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    panel.querySelector(".ads-dispute-close").addEventListener("click", function () { overlay.remove(); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });
    panel.querySelectorAll(".ads-mark-canonical").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var factId = btn.getAttribute("data-fact-id");
        var competing = btn.getAttribute("data-competing") || null;
        try {
          await fetch(API + "/api/facts/" + encodeURIComponent(factId) + "/resolve-dispute", {
            method: "POST", credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ competing_fact_id: competing, decision: "canonical" }),
          });
          cache.delete(factId);
          if (competing) cache.delete(competing);
          overlay.remove();
          decorate(); // refresh badges
        } catch (e) { alert("Resolve failed: " + e.message); }
      });
    });
    if (opts && opts.onDispute) opts.onDispute(data);
  }

  function pillHtml(data) {
    var citCount = (data.citations || []).length;
    var verified = Number((data.fact || {}).verified_score || 0);
    var contradicting = (data.citations || []).filter(function (c) { return c.contradicts === 1; }).length;
    var icon = "";
    if (contradicting > 0) icon = '<span title="contradicting" style="color:#a33;font-weight:700;margin-left:3px">⚑</span>';
    else if (verified >= 0.7) icon = '<span title="verified" style="color:#1a7a35;font-weight:700;margin-left:3px">✓</span>';
    else if (verified < 0.3) icon = '<span title="unverified" style="color:#a36a00;font-weight:700;margin-left:3px">⚠</span>';
    var pill = citCount > 0
      ? '<sup class="ads-cite-pill" style="cursor:pointer;color:#2c6eb5;font-weight:600;margin-left:2px">(' + citCount + ")</sup>"
      : "";
    return pill + icon;
  }

  async function decorate(rootEl) {
    var root = rootEl || document;
    var nodes = root.querySelectorAll(".ads-fact[data-fact-id]:not([data-cite-done])");
    nodes.forEach(function (n) { n.setAttribute("data-cite-done", "1"); });
    for (var i = 0; i < nodes.length; i++) {
      (function (node) {
        var id = node.getAttribute("data-fact-id");
        fetchFact(id).then(function (data) {
          if (!data) return;
          var holder = document.createElement("span");
          holder.innerHTML = pillHtml(data);
          while (holder.firstChild) {
            var child = holder.firstChild;
            if (child.classList && child.classList.contains("ads-cite-pill")) {
              child.setAttribute("tabindex", "0");
              child.setAttribute("role", "button");
              child.setAttribute("aria-label", "Show citations");
              var open = function (e) { if (e) e.stopPropagation(); openPopover(node, data, {}); };
              child.addEventListener("click", open);
              child.addEventListener("mouseenter", open);
              child.addEventListener("focus", open);
              child.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } });
            }
            node.appendChild(child);
          }
          // Hovering anywhere on the fact value (not just the pill) also opens
          // the popover — satisfies the spec's "hover fact pill reveals
          // supporting citations" requirement when fact text is the natural target.
          node.addEventListener("mouseenter", function () { openPopover(node, data, {}); });
          node.addEventListener("focus", function () { openPopover(node, data, {}); });
          if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "0");
        });
      })(nodes[i]);
    }
  }

  document.addEventListener("DOMContentLoaded", function () { decorate(); });

  window.ADS.CitationPills = { decorate: decorate, openDisputeView: openDisputeView };
})();
