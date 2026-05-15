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
        html += '<table class="ads-table"><thead><tr>'
          + '<th>Name</th><th>Kind</th><th>Org / Title</th><th>Location</th>'
          + '<th>Sweet spot</th><th>#Inv</th><th>Unicorns</th><th>Avg check</th></tr></thead><tbody id="ads-investors-tbody">';
      }
      items.forEach(function (it) {
        html += '<tr>'
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
        html += '</tbody></table>';
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

  function section(id, title, body) {
    return '<details class="ads-card" open style="margin-bottom:12px"><summary style="font-weight:600;cursor:pointer">' + esc(title) + '</summary><div style="margin-top:12px" id="' + id + '">' + body + '</div></details>';
  }

  function renderProfile(p) {
    var loc = p.location || {};
    var c = p.contact || {};
    var profs = p.profiles || {};
    var cs = p.check_size || {};
    var n = p.counters || {};
    var stages = (p.stage_focus || []).map(esc).join(", ");
    var sectors = (p.sector_focus || []).map(esc).join(", ");
    var geos = (p.geo_focus || []).map(esc).join(", ");

    // 1) Header
    var html = '<div class="ads-card" style="margin-bottom:12px">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">'
      + '<div><h1 style="margin:0">' + esc(p.name || "—") + '</h1>'
      + '<div class="ads-muted">' + esc(p.investor_kind || "investor") + ' · ' + esc(p.title || "—") + ' @ ' + esc(p.org || "—") + '</div>'
      + '<div class="ads-muted">' + esc([loc.city, loc.region, loc.country_iso2].filter(Boolean).join(", ") || "—") + '</div></div>'
      + '<div><button class="ads-btn" id="ads-inv-enrich" data-id="' + esc(p.id) + '">Enrich now</button></div>'
      + '</div></div>';

    // 2) Thesis
    html += section("inv-thesis", "Thesis", p.thesis ? '<p>' + esc(p.thesis) + '</p>' : '<div class="ads-empty">No thesis on file.</div>');

    // 3) Check size & focus
    html += section("inv-check", "Check size & focus",
      '<table class="ads-table"><tbody>'
      + '<tr><th>Sweet spot stage</th><td>' + esc(p.sweet_spot_stage || "—") + '</td></tr>'
      + '<tr><th>Stages</th><td>' + (stages || "—") + '</td></tr>'
      + '<tr><th>Sectors</th><td>' + (sectors || "—") + '</td></tr>'
      + '<tr><th>Geos</th><td>' + (geos || "—") + '</td></tr>'
      + '<tr><th>Min check</th><td>' + fmtUsd(cs.min_usd) + '</td></tr>'
      + '<tr><th>Typical</th><td>' + fmtUsd(cs.typical_usd) + '</td></tr>'
      + '<tr><th>Max</th><td>' + fmtUsd(cs.max_usd) + '</td></tr>'
      + '</tbody></table>');

    // 4) Counters
    html += section("inv-counters", "Activity", '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">'
      + kpi("Investments", fmtInt(n.investment_count))
      + kpi("Unicorns", fmtInt(n.unicorn_count))
      + kpi("Exits", fmtInt(n.exit_count))
      + kpi("Avg check", fmtUsd(n.avg_check_usd))
      + kpi("Total deployed", fmtUsd(n.total_deployed_usd))
      + kpi("Board seats", fmtInt(n.board_seats_count))
      + kpi("Media", fmtInt(n.media_count))
      + kpi("Podcasts", fmtInt(n.podcast_count))
      + '</div>');

    // 5) Fund (current employer)
    var f = p.fund;
    html += section("inv-fund", "Current fund", f
      ? ('<p><strong>' + esc(f.name) + '</strong> · ' + esc(f.kind || "") + ' · ' + esc(f.hq_city || "—") + '</p>'
         + '<p>AUM: ' + fmtUsd(f.aum_usd) + ' · Current fund: ' + fmtUsd(f.current_fund_size_usd) + '</p>')
      : '<div class="ads-empty">No fund linked.</div>');

    // 6) Portfolio
    html += section("inv-portfolio", "Portfolio (" + (p.portfolio || []).length + ")",
      (p.portfolio || []).length
        ? '<table class="ads-table"><thead><tr><th>Company</th><th>Stage</th><th>Amount</th><th>Lead?</th><th>Date</th></tr></thead><tbody>'
          + p.portfolio.map(function (i) {
              return '<tr><td>' + (i.company_id ? '<a href="/dashboard/companies/detail/?id=' + esc(i.company_id) + '">' + esc(i.company_name || "—") + '</a>' : esc(i.company_name || "—")) + '</td>'
                + '<td>' + esc(i.stage || "—") + '</td>'
                + '<td>' + fmtUsd(i.amount_usd) + '</td>'
                + '<td>' + (i.is_lead ? "Y" : "N") + '</td>'
                + '<td>' + esc(i.invested_at || "—") + '</td></tr>';
            }).join("") + '</tbody></table>'
        : '<div class="ads-empty">No portfolio rows yet.</div>');

    // 7) Breakdowns
    var br = p.breakdowns || {};
    html += section("inv-breakdowns", "Breakdowns", breakdownTable(br.stage, "Stage")
      + breakdownTable(br.sector, "Sector") + breakdownTable(br.geography, "Geography"));

    // 8) Co-investors
    html += section("inv-coinvestors", "Co-investors (" + (p.co_investors || []).length + ")",
      (p.co_investors || []).length
        ? '<ul>' + p.co_investors.map(function (ci) {
            return '<li><a href="/dashboard/investors/detail/?id=' + esc(ci.investor_lead_id) + '">' + esc(ci.name || ci.investor_lead_id) + '</a> — ' + fmtInt(ci.shared) + ' shared</li>';
          }).join("") + '</ul>'
        : '<div class="ads-empty">No co-investors yet.</div>');

    // 9) Boards & advisory
    html += section("inv-boards", "Boards & advisory",
      (p.boards || []).length
        ? '<ul>' + p.boards.map(function (b) { return '<li>' + esc(b.company || b.org || JSON.stringify(b)) + (b.role ? ' — ' + esc(b.role) : "") + '</li>'; }).join("") + '</ul>'
        : '<div class="ads-empty">No board seats on file.</div>');

    // 10) Media
    html += section("inv-media", "Recent media (portfolio)",
      (p.media || []).length
        ? '<ul>' + p.media.slice(0, 30).map(function (m) {
            return '<li><a target="_blank" rel="noopener" href="' + esc(m.url) + '">' + esc(m.title || m.url) + '</a> <span class="ads-muted">— ' + esc(m.company_name || "") + ' · ' + esc(m.published_at || "") + '</span></li>';
          }).join("") + '</ul>'
        : '<div class="ads-empty">No media yet.</div>');

    // 11) Contact & profiles
    html += section("inv-contact", "Contact & profiles",
      '<table class="ads-table"><tbody>'
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
      + '</tbody></table>');

    // 12) History
    html += section("inv-history", "Change history (last 50)",
      (p.history || []).length
        ? '<table class="ads-table"><thead><tr><th>When</th><th>Field</th><th>Old → New</th><th>Source</th></tr></thead><tbody>'
          + p.history.map(function (h) {
              return '<tr><td>' + esc(h.changed_at) + '</td><td>' + esc(h.field) + '</td>'
                + '<td><span class="ads-muted">' + esc(String(h.old_value || "")).slice(0, 40) + '</span> → ' + esc(String(h.new_value || "")).slice(0, 40) + '</td>'
                + '<td>' + esc(h.source || "—") + (h.evidence_url ? ' · <a target="_blank" rel="noopener" href="' + esc(h.evidence_url) + '">evidence</a>' : "") + '</td></tr>';
            }).join("") + '</tbody></table>'
        : '<div class="ads-empty">No history yet.</div>');

    return html;
  }

  function kpi(label, val) {
    return '<div class="ads-card" style="text-align:center;padding:8px"><div class="ads-muted" style="font-size:11px">' + esc(label) + '</div><div style="font-size:18px;font-weight:600">' + val + '</div></div>';
  }
  function breakdownTable(map, label) {
    map = map || {};
    var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
    if (!keys.length) return '<div class="ads-muted">No ' + esc(label) + ' breakdown.</div>';
    return '<table class="ads-table" style="margin-bottom:8px"><thead><tr><th>' + esc(label) + '</th><th>Count</th></tr></thead><tbody>'
      + keys.map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + fmtInt(map[k]) + '</td></tr>'; }).join("")
      + '</tbody></table>';
  }
  function linkRow(label, href, txt) {
    if (!txt) return '<tr><th>' + esc(label) + '</th><td class="ads-muted">—</td></tr>';
    return '<tr><th>' + esc(label) + '</th><td><a target="_blank" rel="noopener" href="' + esc(href) + '">' + esc(txt) + '</a></td></tr>';
  }

  function wireProfileActions(p) {
    var btn = document.getElementById("ads-inv-enrich");
    if (!btn) return;
    btn.addEventListener("click", function () {
      btn.disabled = true; btn.textContent = "Queuing…";
      api("/api/investors/" + encodeURIComponent(p.id) + "/enrich", { method: "POST" })
        .then(function () { btn.textContent = "Queued ✓"; })
        .catch(function (e) { btn.textContent = "Failed: " + e.message; btn.disabled = false; });
    });
  }
})();
