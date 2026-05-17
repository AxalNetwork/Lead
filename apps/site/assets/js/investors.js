// Task #24 — Investors browse + detail (vanilla JS, no CDN).
// Uses window.adsApiFetch (set by dashboard.js) so the CF Access cookie
// rides along on every API call.
(function () {
  var API = window.adsApiBase || "https://api.aidatasignal.com";

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmtInt(n) { return n == null ? "—" : new Intl.NumberFormat("en-US").format(n); }
  function fmtUsd(n) {
    if (n == null) return "—";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
    return "$" + n;
  }
  function api(path, opts) {
    var fn = window.adsApiFetch || function (p, o) {
      return fetch(API + p, Object.assign({ credentials: "include" }, o || {})).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    };
    return fn(path, opts);
  }

  // -------- Browse list --------
  function init() {
    var form = document.getElementById("ads-investors-filters");
    if (!form) return;
    var listEl = document.getElementById("ads-investors-list");
    var moreBtn = document.getElementById("ads-investors-more");
    var msg = document.getElementById("ads-investors-msg");
    var state = { offset: 0, query: "" };

    function buildQuery() {
      var fd = new FormData(form);
      var p = new URLSearchParams();
      ["q", "kind", "stage", "sector", "country", "min_check_usd"].forEach(function (k) {
        var v = String(fd.get(k) || "").trim();
        if (v) p.set(k, v);
      });
      p.set("limit", "50");
      return p;
    }

    function renderRows(items, append) {
      if (!items || !items.length) {
        if (!append) listEl.innerHTML = '<div class="ads-empty">No investors found.</div>';
        return;
      }
      var html = "";
      if (!append) {
        html += '<div class="ads-table-wrap"><table class="ads-table"><thead><tr>'
          + '<th style="width:32px"><input type="checkbox" id="ads-bulk-header-check" title="Select page (click twice for all matching)"></th>'
          + '<th>Name</th><th>Kind</th><th>Org / Title</th><th>Location</th>'
          + '<th>Sweet spot</th><th>#Inv</th><th>Unicorns</th><th>Avg check</th></tr></thead><tbody id="ads-investors-tbody">';
      }
      items.forEach(function (it) {
        html += '<tr data-id="' + esc(it.id) + '">'
          + '<td><input type="checkbox" class="ads-bulk-check" data-id="' + esc(it.id) + '"></td>'
          + '<td><a href="/dashboard/investors/detail/?id=' + encodeURIComponent(it.id) + '">' + esc(it.name || "—") + '</a></td>'
          + '<td>' + esc(it.investor_kind || "—") + '</td>'
          + '<td>' + esc(it.org || "—") + (it.title ? ' <span class="ads-muted">· ' + esc(it.title) + '</span>' : "") + '</td>'
          + '<td>' + esc([it.city, it.country_iso2].filter(Boolean).join(", ") || "—") + '</td>'
          + '<td>' + esc(it.sweet_spot_stage || "—") + '</td>'
          + '<td>' + fmtInt(it.investment_count) + '</td>'
          + '<td>' + fmtInt(it.unicorn_count) + '</td>'
          + '<td>' + fmtUsd(it.avg_check_usd) + '</td>'
          + '</tr>';
      });
      if (!append) {
        html += '</tbody></table></div>';
        listEl.innerHTML = html;
      } else {
        var tbody = document.getElementById("ads-investors-tbody");
        if (tbody) tbody.insertAdjacentHTML("beforeend", html);
      }
    }

    function load(append) {
      var p = buildQuery();
      if (append) p.set("offset", String(state.offset));
      msg.textContent = append ? "Loading more…" : "Loading…";
      api("/api/investors?" + p.toString())
        .then(function (data) {
          renderRows(data.items, append);
          state.offset = data.nextOffset == null ? state.offset : data.nextOffset;
          moreBtn.hidden = data.nextOffset == null;
          msg.textContent = "";
        })
        .catch(function (e) { msg.textContent = "Error: " + e.message; });
    }

    function loadAggregate() {
      api("/api/investors/aggregate").then(function (a) {
        var strip = document.getElementById("ads-investors-strip");
        if (!strip) return;
        var byKind = (a.by_kind || []).map(function (r) { return esc(r.k) + ": " + fmtInt(r.n); }).join(" · ");
        strip.innerHTML =
          '<strong>' + fmtInt(a.total) + '</strong> investors · ' +
          fmtInt(a.totals && a.totals.investments) + ' investments · ' +
          fmtInt(a.totals && a.totals.unicorns) + ' unicorns · ' +
          fmtInt(a.totals && a.totals.exits) + ' exits' +
          (byKind ? '<div class="ads-muted" style="margin-top:6px;font-size:12px">' + byKind + '</div>' : '');
      }).catch(function () {});
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); state.offset = 0; load(false); });
    form.addEventListener("reset", function () { setTimeout(function () { state.offset = 0; load(false); }, 0); });
    moreBtn.addEventListener("click", function () { load(true); });

    loadAggregate();
    load(false);

    if (window.adsBulkBar) {
      window.adsBulkBar.init({
        pageId: "investors",
        getRowHost: function () { return document.getElementById("ads-investors-list"); },
        getRows: function () { return document.querySelectorAll("#ads-investors-tbody tr[data-id]"); },
        fetchAllMatchingIds: function () {
          // Server caps `limit` at 200 — paginate until cap (5000) or empty.
          var all = []; var off = 0;
          function nextPage() {
            var p = buildQuery(); p.set("limit", "200"); p.set("offset", String(off));
            return api("/api/investors?" + p.toString()).then(function (d) {
              var items = d.items || [];
              for (var i = 0; i < items.length && all.length < 5000; i++) all.push(items[i].id);
              if (d.nextOffset != null && all.length < 5000) { off = d.nextOffset; return nextPage(); }
              return all;
            });
          }
          return nextPage();
        },
      });
    }
  }
  document.addEventListener("DOMContentLoaded", init);

  // -------- Detail page (12 sections) --------
  window.adsRenderInvestorDetail = function () {
    var root = document.getElementById("ads-investor-detail");
    if (!root) return;
    var id = new URLSearchParams(window.location.search).get("id");
    if (!id) { root.innerHTML = '<div class="ads-empty">Missing ?id=…</div>'; return; }
    api("/api/investors/" + encodeURIComponent(id) + "/profile")
      .then(function (p) { root.innerHTML = renderProfile(p); wireProfileActions(p); })
      .catch(function (e) { root.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; });
  };

  function tab(id, label, body) { return { id: id, label: label, body: body }; }
  function empty(msg) { return '<div class="ads-empty">' + esc(msg) + '</div>'; }

  function renderProfile(p) {
    var loc = p.location || {};
    var c = p.contact || {};
    var profs = p.profiles || {};
    var cs = p.check_size || {};
    var n = p.counters || {};
    var br = p.breakdowns || {};
    var f = p.fund;

    // 12 tabs in the order required by the spec.
    var tabs = [
      tab("about", "About",
        '<div class="ads-card"><h2 style="margin:0 0 8px">' + esc(p.name || "—") + '</h2>'
        + '<div class="ads-muted">' + esc(p.investor_kind || "investor") + ' · ' + esc(p.title || "—")
        + (p.org ? ' @ ' + esc(p.org) : "") + '</div>'
        + '<div class="ads-muted">' + esc([loc.city, loc.region, loc.country_iso2].filter(Boolean).join(", ") || "—") + '</div>'
        + (p.thesis ? '<h3 style="margin-top:14px">Thesis</h3><p>' + esc(p.thesis) + '</p>' : '<p class="ads-empty" style="margin-top:14px">No thesis on file.</p>')
        + '</div>'),

      tab("focus", "Thesis & focus",
        (p.thesis ? '<div class="ads-card" style="margin-bottom:12px"><h3 style="margin-top:0">Thesis</h3><p>' + esc(p.thesis) + '</p></div>' : '')
        + '<div class="ads-table-wrap"><table class="ads-table"><tbody>'
        + '<tr><th>Sweet spot stage</th><td>' + esc(p.sweet_spot_stage || "—") + '</td></tr>'
        + '<tr><th>Stages</th><td>' + ((p.stage_focus || []).map(esc).join(", ") || "—") + '</td></tr>'
        + '<tr><th>Sectors</th><td>' + ((p.sector_focus || []).map(esc).join(", ") || "—") + '</td></tr>'
        + '<tr><th>Geos</th><td>' + ((p.geo_focus || []).map(esc).join(", ") || "—") + '</td></tr>'
        + '<tr><th>Min check</th><td>' + fmtUsd(cs.min_usd) + '</td></tr>'
        + '<tr><th>Typical check</th><td>' + fmtUsd(cs.typical_usd) + '</td></tr>'
        + '<tr><th>Max check</th><td>' + fmtUsd(cs.max_usd) + '</td></tr>'
        + '<tr><th>Avg actual</th><td>' + fmtUsd(n.avg_check_usd) + '</td></tr>'
        + '<tr><th>Total deployed</th><td>' + fmtUsd(n.total_deployed_usd) + '</td></tr>'
        + '<tr><th>Investments</th><td>' + fmtInt(n.investment_count) + '</td></tr>'
        + '<tr><th>Unicorns</th><td>' + fmtInt(n.unicorn_count) + '</td></tr>'
        + '<tr><th>Exits</th><td>' + fmtInt(n.exit_count) + '</td></tr>'
        + '</tbody></table></div>'),

      tab("stage", "Stage",
        Object.keys(br.stage || {}).length ? breakdownTable(br.stage, "Stage focus") : empty("No stage breakdown yet.")),

      tab("sector", "Sector",
        Object.keys(br.sector || {}).length ? breakdownTable(br.sector, "Sector focus") : empty("No sector breakdown yet.")),

      tab("geography", "Geography",
        Object.keys(br.geography || {}).length ? breakdownTable(br.geography, "Geography focus") : empty("No geography breakdown yet.")),

      tab("portfolio", "Portfolio",
        (p.portfolio || []).length
          ? '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>Company</th><th>Stage</th><th>Amount</th><th>Lead?</th><th>Date</th></tr></thead><tbody>'
            + p.portfolio.map(function (i) {
                return '<tr><td>' + (i.company_id ? '<a href="/dashboard/companies/detail/?id=' + esc(i.company_id) + '">' + esc(i.company_name || "—") + '</a>' : esc(i.company_name || "—")) + '</td>'
                  + '<td>' + esc(i.stage || "—") + '</td><td>' + fmtUsd(i.amount_usd) + '</td>'
                  + '<td>' + (i.is_lead ? "Y" : "N") + '</td><td>' + esc(i.invested_at || "—") + '</td></tr>';
              }).join("") + '</tbody></table></div>'
          : empty("No portfolio rows yet.")),

      tab("network", "Network (co-investors)",
        '<h3 style="margin-top:0">Co-investors</h3>'
        + ((p.co_investors || []).length
            ? '<ul>' + p.co_investors.map(function (ci) {
                return '<li><a href="/dashboard/investors/detail/?id=' + esc(ci.investor_lead_id) + '">' + esc(ci.name || ci.investor_lead_id) + '</a> — ' + fmtInt(ci.shared) + ' shared deals</li>';
              }).join("") + '</ul>'
            : empty("No co-investors yet."))
        + '<h3>Current fund</h3>'
        + (f
            ? '<p><strong>' + esc(f.name) + '</strong> · ' + esc(f.kind || "") + ' · ' + esc(f.hq_city || "—")
              + '</p><p>AUM: ' + fmtUsd(f.aum_usd) + ' · Current fund: ' + fmtUsd(f.current_fund_size_usd) + '</p>'
            : empty("No fund linked."))),

      tab("path", "Path to this investor",
        '<form id="ads-inv-path-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<label>From lead id <input name="from" required style="padding:6px;width:280px" placeholder="paste a lead id you control"></label>'
        + '<button class="ads-btn" type="submit">Find path</button>'
        + '</form>'
        + '<div id="ads-inv-path-result" style="margin-top:12px"><div class="ads-muted">Enter a starting lead id (yours or a teammate\'s) to compute the shortest connection chain.</div></div>'),

      tab("boards", "Boards",
        (p.boards || []).length
          ? '<ul>' + p.boards.map(function (b) { return '<li>' + esc(b.company || b.org || JSON.stringify(b)) + (b.role ? ' — ' + esc(b.role) : "") + '</li>'; }).join("") + '</ul>'
          : empty("No board seats on file.")),

      tab("media", "Media",
        (p.media || []).length
          ? '<ul>' + p.media.slice(0, 50).map(function (m) {
              return '<li><a target="_blank" rel="noopener" href="' + esc(m.url) + '">' + esc(m.title || m.url) + '</a> <span class="ads-muted">— ' + esc(m.company_name || "") + ' · ' + esc(m.published_at || "") + '</span></li>';
            }).join("") + '</ul>'
          : empty("No media yet.")),

      tab("contact", "Contact",
        '<div class="ads-table-wrap"><table class="ads-table"><tbody>'
        + linkRow("Email", c.email ? 'mailto:' + c.email : null, c.email)
        + linkRow("LinkedIn", c.linkedin_url, c.linkedin_url)
        + linkRow("Twitter", c.twitter_url, c.twitter_url)
        + linkRow("GitHub", c.github_url, c.github_url)
        + linkRow("Website", c.personal_url, c.personal_url)
        + linkRow("Office hours", c.office_hours_url, c.office_hours_url)
        + linkRow("Pitch form", c.pitch_form_url, c.pitch_form_url)
        + linkRow("Calendly", c.calendly_url, c.calendly_url)
        + linkRow("NFX Signal", profs.signal_nfx_url, profs.signal_nfx_url)
        + linkRow("Crunchbase", profs.crunchbase_url, profs.crunchbase_url)
        + linkRow("Wikipedia", profs.wikipedia_url, profs.wikipedia_url)
        + '</tbody></table></div>'),

      tab("history", "History",
        (p.history || []).length
          ? '<div class="ads-table-wrap"><table class="ads-table"><thead><tr><th>When</th><th>Field</th><th>Old → New</th><th>Source</th></tr></thead><tbody>'
            + p.history.map(function (h) {
                return '<tr><td>' + esc(h.changed_at) + '</td><td>' + esc(h.field) + '</td>'
                  + '<td><span class="ads-muted">' + esc(String(h.old_value || "")).slice(0, 40) + '</span> → ' + esc(String(h.new_value || "")).slice(0, 40) + '</td>'
                  + '<td>' + esc(h.source || "—") + (h.evidence_url ? ' · <a target="_blank" rel="noopener" href="' + esc(h.evidence_url) + '">evidence</a>' : "") + '</td></tr>';
              }).join("") + '</tbody></table></div>'
          : empty("No history yet.")),
    ];

    var nav = '<div class="ads-tabs" role="tablist">' + tabs.map(function (t, i) {
      return '<button role="tab" data-tab="' + t.id + '" aria-selected="' + (i === 0 ? "true" : "false") + '">' + esc(t.label) + '</button>';
    }).join("") + '</div>';
    var panels = tabs.map(function (t, i) {
      return '<div class="ads-tab-panel" data-tab="' + t.id + '" data-active="' + (i === 0 ? "1" : "0") + '">' + t.body + '</div>';
    }).join("");

    var sidebar = '<aside class="ads-card ads-detail-side">'
      + '<h3 style="margin-top:0">Actions</h3>'
      + '<button class="ads-btn" id="ads-inv-enrich" data-id="' + esc(p.id) + '" style="width:100%;margin-bottom:6px">Enrich now</button>'
      + (c.email ? '<a class="ads-btn ads-btn--ghost" style="display:block;text-align:center;margin-bottom:6px" href="mailto:' + esc(c.email) + '">Email</a>' : '')
      + (c.linkedin_url ? '<a class="ads-btn ads-btn--ghost" style="display:block;text-align:center;margin-bottom:6px" target="_blank" rel="noopener" href="' + esc(c.linkedin_url) + '">LinkedIn</a>' : '')
      + '<hr><div class="ads-muted" style="font-size:12px">Last enriched: ' + esc(p.last_enriched_at || "never") + '</div>'
      + '<div class="ads-muted" style="font-size:12px">Lead id: <code>' + esc(p.id) + '</code></div>'
      + '</aside>';

    return '<div class="ads-detail-grid"><div>' + nav + panels + '</div>' + sidebar + '</div>';
  }

  function kpi(label, val) {
    return '<div class="ads-card" style="text-align:center;padding:8px"><div class="ads-muted" style="font-size:11px">' + esc(label) + '</div><div style="font-size:18px;font-weight:600">' + val + '</div></div>';
  }
  function breakdownTable(map, label) {
    map = map || {};
    var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
    if (!keys.length) return '<div class="ads-muted">No ' + esc(label) + ' breakdown.</div>';
    return '<div class="ads-table-wrap"><table class="ads-table" style="margin-bottom:8px"><thead><tr><th>' + esc(label) + '</th><th>Count</th></tr></thead><tbody>'
      + keys.map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + fmtInt(map[k]) + '</td></tr>'; }).join("")
      + '</tbody></table></div>';
  }
  function linkRow(label, href, txt) {
    if (!txt) return '<tr><th>' + esc(label) + '</th><td class="ads-muted">—</td></tr>';
    return '<tr><th>' + esc(label) + '</th><td><a target="_blank" rel="noopener" href="' + esc(href) + '">' + esc(txt) + '</a></td></tr>';
  }

  function wireProfileActions(p) {
    // Tab switching.
    var tabBtns = document.querySelectorAll('#ads-investor-detail .ads-tabs button');
    tabBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        tabBtns.forEach(function (x) { x.setAttribute("aria-selected", "false"); });
        b.setAttribute("aria-selected", "true");
        var id = b.getAttribute("data-tab");
        document.querySelectorAll('#ads-investor-detail .ads-tab-panel').forEach(function (panel) {
          panel.setAttribute("data-active", panel.getAttribute("data-tab") === id ? "1" : "0");
        });
      });
    });

    var btn = document.getElementById("ads-inv-enrich");
    if (btn) {
      btn.addEventListener("click", function () {
        btn.disabled = true; btn.textContent = "Enriching…";
        api("/api/investors/" + encodeURIComponent(p.id) + "/enrich", { method: "POST" })
          .then(function () { btn.textContent = "Done ✓ (refresh to see)"; })
          .catch(function (e) { btn.textContent = "Failed: " + e.message; btn.disabled = false; });
      });
    }

    // "Path to this investor" form.
    var form = document.getElementById("ads-inv-path-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var from = String(new FormData(form).get("from") || "").trim();
        var resultEl = document.getElementById("ads-inv-path-result");
        if (!from) { resultEl.innerHTML = empty("Enter a from lead id."); return; }
        resultEl.innerHTML = '<div class="ads-loading">Searching…</div>';
        api("/api/investors/" + encodeURIComponent(from) + "/path?to=" + encodeURIComponent(p.id))
          .then(function (r) {
            if (!r || (!r.path && !r.nodes)) { resultEl.innerHTML = empty("No path found within 4 hops."); return; }
            // Format result whether it's a {nodes,edges,hops} (relationships) or {path:[...]} (legacy).
            if (r.nodes && r.edges) {
              if (r.hops < 0 || !r.nodes.length) { resultEl.innerHTML = empty("No path found within 4 hops."); return; }
              resultEl.innerHTML = '<p><strong>' + r.hops + '-hop path:</strong></p>'
                + '<ol>' + r.nodes.map(function (nd) { return '<li>' + esc(nd.name) + ' <span class="ads-muted">(' + esc(nd.kind) + ')</span></li>'; }).join("") + '</ol>';
            } else if (Array.isArray(r.path)) {
              resultEl.innerHTML = '<ol>' + r.path.map(function (link) {
                return '<li>' + esc(link.from) + ' →[<em>' + esc(link.kind) + '</em>]→ ' + esc(link.to) + '</li>';
              }).join("") + '</ol>';
            } else {
              resultEl.innerHTML = empty("No path found within 4 hops.");
            }
          })
          .catch(function (e) { resultEl.innerHTML = empty("Search failed: " + e.message); });
      });
    }
  }
})();
