// Task #44 — Accounts (prospect database) browse page.
(function () {
  var API = window.adsApiBase || "https://api.aidatasignal.com";
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmtNum(n) { if (n == null || isNaN(n)) return "—"; return Math.round(Number(n) * 10) / 10; }
  function bar(v, max) {
    var pct = Math.min(100, Math.max(0, (Number(v) / (max || 100)) * 100));
    return '<span class="ads-bar"><span style="width:' + pct.toFixed(0) + '%"></span></span>' + fmtNum(v);
  }
  function api(path, opts) {
    var fn = window.adsApiFetch || function (p, o) {
      return fetch(API + p, Object.assign({ credentials: "include" }, o || {})).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
      });
    };
    return fn(path, opts);
  }
  function chips(items) {
    if (!items || !items.length) return '<span class="ads-muted">—</span>';
    return items.slice(0, 3).map(function (k) {
      return '<span class="ads-chip" title="raw=' + esc(String(k.raw_contribution)) + '">' + esc(k.kind) + " ×" + esc(String(k.count)) + "</span>";
    }).join("");
  }

  var state = { offset: 0, limit: 50 };

  function buildQs() {
    var form = document.getElementById("ads-accounts-filters");
    var fd = new FormData(form);
    var qs = new URLSearchParams();
    fd.forEach(function (v, k) { if (v !== "" && v != null) qs.set(k, v); });
    qs.set("limit", String(state.limit));
    qs.set("offset", String(state.offset));
    return qs.toString();
  }

  function renderRows(items) {
    var tbody = document.getElementById("ads-accounts-tbody");
    if (!items.length && state.offset === 0) {
      tbody.innerHTML = '<tr><td class="ads-muted" colspan="9">No accounts. Create one via POST /api/accounts or use bulk import.</td></tr>';
      return;
    }
    function checkCell(a) {
      return '<td style="padding:8px;vertical-align:middle"><input type="checkbox" class="ads-bulk-check" data-id="' + esc(a.id) + '"></td>';
    }
    function logoCell(a) {
      // Prefer Cloudflare Images logo_id, fall back to Google's favicon
      // service keyed by domain so the column is never empty when a
      // domain exists. Initial-letter chip when neither is available.
      if (a.logo_id) {
        return '<img src="https://imagedelivery.net/' + esc(a.logo_id) + '/thumbnail" alt="" width="28" height="28" style="border-radius:6px;object-fit:cover" loading="lazy" />';
      }
      if (a.domain) {
        return '<img src="https://www.google.com/s2/favicons?sz=64&domain=' + esc(a.domain) + '" alt="" width="24" height="24" style="border-radius:4px" loading="lazy" />';
      }
      var letter = (a.name || "?").trim().charAt(0).toUpperCase();
      return '<span style="display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;background:#eef;border-radius:6px;font-weight:600;font-size:12px">' + esc(letter) + "</span>";
    }
    var html = items.map(function (a) {
      var top = (a.intent_breakdown && a.intent_breakdown.by_kind) || [];
      return '<tr data-id="' + esc(a.id) + '">' +
        checkCell(a) +
        '<td style="padding:8px;vertical-align:middle">' + logoCell(a) + "</td>" +
        '<td style="padding:8px"><a href="/dashboard/accounts/detail/?id=' + esc(a.id) + '">' + esc(a.name) + "</a>" +
          (a.domain ? '<div class="ads-muted" style="font-size:11px">' + esc(a.domain) + "</div>" : "") + "</td>" +
        '<td style="padding:8px">' + esc(a.industry || "—") + "</td>" +
        '<td style="padding:8px">' + esc(a.size_band || "—") + "</td>" +
        '<td style="padding:8px">' + chips(top) + "</td>" +
        '<td style="padding:8px;text-align:right">' + bar(a.intent_score) + "</td>" +
        '<td style="padding:8px;text-align:right">' + bar(a.fit_score) + "</td>" +
        '<td style="padding:8px;text-align:right;font-weight:600">' + bar(a.account_score) + "</td>" +
      "</tr>";
    }).join("");
    if (state.offset === 0) tbody.innerHTML = html; else tbody.insertAdjacentHTML("beforeend", html);
  }

  function renderStrip(agg) {
    var strip = document.getElementById("ads-accounts-strip");
    if (!strip || !agg) return;
    strip.querySelector('[data-k="total"]').textContent = agg.total != null ? agg.total : "—";
    strip.querySelector('[data-k="avg_account_score"]').textContent = fmtNum(agg.avg_account_score);
    strip.querySelector('[data-k="avg_intent_score"]').textContent = fmtNum(agg.avg_intent_score);
    strip.querySelector('[data-k="avg_fit_score"]').textContent = fmtNum(agg.avg_fit_score);
    var inds = (agg.by_industry || []).slice(0, 3).map(function (i) { return esc(i.k) + " (" + i.n + ")"; }).join(", ");
    strip.querySelector('[data-k="industries"]').textContent = inds || "—";
  }

  function load(append) {
    var msg = document.getElementById("ads-accounts-msg");
    if (msg) msg.textContent = "loading…";
    api("/api/accounts?" + buildQs()).then(function (r) {
      renderRows(r.items || []);
      renderStrip(r.aggregates);
      var more = document.getElementById("ads-accounts-loadmore");
      if (more) {
        if (r.nextOffset != null) { more.hidden = false; more.dataset.next = String(r.nextOffset); }
        else { more.hidden = true; }
      }
      var shown = document.getElementById("ads-accounts-shown");
      if (shown) shown.textContent = (r.items ? r.items.length : 0) + " row(s)";
      if (msg) msg.textContent = "";
    }).catch(function (e) {
      if (msg) msg.textContent = "load failed: " + e.message;
    });
    void append;
  }

  function loadSignalKinds() {
    api("/api/signals/kinds").then(function (r) {
      var sel = document.getElementById("ads-accts-signal-kind");
      if (!sel) return;
      (r.kinds || []).forEach(function (k) {
        var o = document.createElement("option"); o.value = k; o.textContent = k; sel.appendChild(o);
      });
    }).catch(function () { /* ignore */ });
  }

  function init() {
    var form = document.getElementById("ads-accounts-filters");
    if (!form) return;
    form.addEventListener("submit", function (e) { e.preventDefault(); state.offset = 0; load(false); });
    form.addEventListener("reset", function () { setTimeout(function () { state.offset = 0; load(false); }, 0); });
    var more = document.getElementById("ads-accounts-loadmore");
    if (more) more.addEventListener("click", function () {
      state.offset = Number(more.dataset.next || 0); load(true);
    });
    loadSignalKinds();
    load(false);

    if (window.adsBulkBar && window.adsBulkBar.init) {
      var bar = window.adsBulkBar.init({
        pageId: "accounts",
        getRowHost: function () { return document.getElementById("ads-accounts-tbody"); },
        getRows: function () { return document.querySelectorAll("#ads-accounts-tbody tr[data-id]"); },
        getFilterSignature: function () {
          // Filter signature = serialized form values + sort. Selection
          // is invalidated whenever this string changes.
          var fd = new FormData(form);
          var pairs = [];
          fd.forEach(function (v, k) { pairs.push(k + "=" + String(v)); });
          pairs.sort();
          return pairs.join("&");
        },
        fetchAllMatchingIds: function () {
          // /api/accounts caps `limit` at 200 — paginate up to the 5000
          // bulk cap.
          var all = []; var off = 0;
          function nextPage() {
            var fd = new FormData(form);
            var qs = new URLSearchParams();
            fd.forEach(function (v, k) { if (v !== "" && v != null) qs.set(k, v); });
            qs.set("limit", "200"); qs.set("offset", String(off));
            return api("/api/accounts?" + qs.toString()).then(function (d) {
              var items = d.items || [];
              for (var i = 0; i < items.length && all.length < 5000; i++) all.push(items[i].id);
              if (d.nextOffset != null && all.length < 5000) { off = d.nextOffset; return nextPage(); }
              return all;
            });
          }
          return nextPage();
        },
      });
      form.addEventListener("submit", function () { setTimeout(function () { bar.onFilterChange(); }, 50); });
      form.addEventListener("reset", function () { setTimeout(function () { bar.onFilterChange(); }, 50); });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
