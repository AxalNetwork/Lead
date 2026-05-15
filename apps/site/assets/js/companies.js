// Task #24 — Companies browse + detail.
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
        if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
      });
    };
    return fn(path, opts);
  }

  function init() {
    var form = document.getElementById("ads-companies-filters");
    if (!form) return;
    var listEl = document.getElementById("ads-companies-list");
    var moreBtn = document.getElementById("ads-companies-more");
    var msg = document.getElementById("ads-companies-msg");
    var state = { offset: 0 };

    function buildQuery() {
      var fd = new FormData(form);
      var p = new URLSearchParams();
      ["q", "status", "stage", "sector", "country"].forEach(function (k) {
        var v = String(fd.get(k) || "").trim(); if (v) p.set(k, v);
      });
      if (fd.get("unicorn") === "1") p.set("unicorn", "1");
      p.set("limit", "50");
      return p;
    }

    function renderRows(items, append) {
      if (!items || !items.length) {
        if (!append) listEl.innerHTML = '<div class="ads-empty">No companies found.</div>';
        return;
      }
      var html = "";
      if (!append) {
        html += '<table class="ads-table"><thead><tr><th>Name</th><th>Stage</th><th>Funding</th><th>Last round</th><th>Valuation</th><th>Status</th><th>Location</th></tr></thead><tbody id="ads-companies-tbody">';
      }
      items.forEach(function (it) {
        html += '<tr>'
          + '<td><a href="/dashboard/companies/detail/?id=' + encodeURIComponent(it.id) + '">' + esc(it.name) + '</a>'
          + (it.unicorn ? ' <span class="ads-pill warn">🦄</span>' : "") + '</td>'
          + '<td>' + esc(it.stage || "—") + '</td>'
          + '<td>' + fmtUsd(it.total_funding_usd) + '</td>'
          + '<td>' + fmtUsd(it.last_round_usd) + (it.last_round_stage ? ' <span class="ads-muted">(' + esc(it.last_round_stage) + ')</span>' : "") + '</td>'
          + '<td>' + fmtUsd(it.valuation_usd) + '</td>'
          + '<td>' + esc(it.status) + '</td>'
          + '<td>' + esc([it.hq_city, it.hq_country_iso2].filter(Boolean).join(", ") || "—") + '</td>'
          + '</tr>';
      });
      if (!append) { html += '</tbody></table>'; listEl.innerHTML = html; }
      else { var tbody = document.getElementById("ads-companies-tbody"); if (tbody) tbody.insertAdjacentHTML("beforeend", html); }
    }

    function load(append) {
      var p = buildQuery();
      if (append) p.set("offset", String(state.offset));
      msg.textContent = append ? "Loading more…" : "Loading…";
      api("/api/companies?" + p.toString())
        .then(function (data) {
          renderRows(data.items, append);
          state.offset = data.nextOffset == null ? state.offset : data.nextOffset;
          moreBtn.hidden = data.nextOffset == null;
          msg.textContent = "";
        })
        .catch(function (e) { msg.textContent = "Error: " + e.message; });
    }

    function loadAggregate() {
      api("/api/companies/aggregate").then(function (a) {
        var strip = document.getElementById("ads-companies-strip");
        if (!strip) return;
        var byStage = (a.by_stage || []).slice(0, 6).map(function (r) { return esc(r.k) + ": " + fmtInt(r.n); }).join(" · ");
        strip.innerHTML =
          '<strong>' + fmtInt(a.total) + '</strong> companies · ' +
          'Total funding: ' + fmtUsd(a.totals && a.totals.total_funding) + ' · ' +
          fmtInt(a.totals && a.totals.unicorns) + ' unicorns · ' +
          'Exits: ' + fmtUsd(a.totals && a.totals.exits) +
          (byStage ? '<div class="ads-muted" style="margin-top:6px;font-size:12px">' + byStage + '</div>' : '');
      }).catch(function () {});
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); state.offset = 0; load(false); });
    form.addEventListener("reset", function () { setTimeout(function () { state.offset = 0; load(false); }, 0); });
    moreBtn.addEventListener("click", function () { load(true); });

    loadAggregate();
    load(false);
  }
  document.addEventListener("DOMContentLoaded", init);

  window.adsRenderCompanyDetail = function () {
    var root = document.getElementById("ads-company-detail");
    if (!root) return;
    var id = new URLSearchParams(window.location.search).get("id");
    if (!id) { root.innerHTML = '<div class="ads-empty">Missing ?id=…</div>'; return; }
    api("/api/companies/" + encodeURIComponent(id) + "/profile")
      .then(function (p) { root.innerHTML = renderProfile(p); wireActions(p); })
      .catch(function (e) { root.innerHTML = '<div class="ads-empty">Failed: ' + esc(e.message) + '</div>'; });
  };

  function section(title, body) {
    return '<details class="ads-card" open style="margin-bottom:12px"><summary style="font-weight:600;cursor:pointer">' + esc(title) + '</summary><div style="margin-top:12px">' + body + '</div></details>';
  }

  function renderProfile(p) {
    var loc = p.location || {}; var f = p.funding || {}; var x = p.exit; var profs = p.profiles || {};
    var html = '<div class="ads-card" style="margin-bottom:12px">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">'
      + '<div><h1 style="margin:0">' + esc(p.name) + (f.unicorn ? ' 🦄' : "") + '</h1>'
      + '<div class="ads-muted">' + esc(p.domain || "") + ' · ' + esc(p.status) + ' · founded ' + esc(p.founded_year || "—") + '</div>'
      + '<div class="ads-muted">' + esc([loc.city, loc.region, loc.country_iso2].filter(Boolean).join(", ") || "—") + '</div>'
      + (p.description ? '<p style="margin-top:8px">' + esc(p.description) + '</p>' : "")
      + '</div>'
      + '<div><button class="ads-btn" id="ads-co-enrich" data-id="' + esc(p.id) + '">Enrich now</button></div>'
      + '</div></div>';

    html += section("Funding",
      '<table class="ads-table"><tbody>'
      + '<tr><th>Total funding</th><td>' + fmtUsd(f.total_funding_usd) + '</td></tr>'
      + '<tr><th>Last round</th><td>' + fmtUsd(f.last_round_usd) + ' (' + esc(f.last_round_stage || "—") + ') on ' + esc(f.last_round_at || "—") + '</td></tr>'
      + '<tr><th>Valuation</th><td>' + fmtUsd(f.valuation_usd) + '</td></tr>'
      + '<tr><th>Stage</th><td>' + esc(p.stage || "—") + '</td></tr>'
      + '</tbody></table>');

    if (x) html += section("Exit",
      '<table class="ads-table"><tbody>'
      + '<tr><th>Kind</th><td>' + esc(x.kind) + '</td></tr>'
      + '<tr><th>Date</th><td>' + esc(x.date || "—") + '</td></tr>'
      + '<tr><th>Value</th><td>' + fmtUsd(x.value_usd) + '</td></tr>'
      + '<tr><th>Acquirer</th><td>' + esc(x.acquirer_name || "—") + '</td></tr>'
      + '<tr><th>Ticker</th><td>' + esc(x.ticker || "—") + '</td></tr>'
      + '</tbody></table>');

    html += section("Founders (" + (p.founders || []).length + ")",
      (p.founders || []).length
        ? '<ul>' + p.founders.map(function (fr) {
            var nm = fr.lead_id
              ? '<a href="/dashboard/lead/?id=' + esc(fr.lead_id) + '">' + esc(fr.name) + '</a>'
              : esc(fr.name);
            return '<li>' + nm + (fr.title ? ' — ' + esc(fr.title) : "") + (fr.is_active ? "" : ' <span class="ads-muted">(former)</span>') + '</li>';
          }).join("") + '</ul>'
        : '<div class="ads-empty">No founders on file.</div>');

    html += section("Rounds (" + (p.rounds || []).length + ")",
      (p.rounds || []).length
        ? '<table class="ads-table"><thead><tr><th>Date</th><th>Stage</th><th>Amount</th><th>Post-money</th><th>Source</th></tr></thead><tbody>'
          + p.rounds.map(function (r) {
              return '<tr><td>' + esc(r.raised_at || "—") + '</td><td>' + esc(r.stage || "—") + '</td><td>' + fmtUsd(r.amount_usd) + '</td><td>' + fmtUsd(r.post_money_usd) + '</td>'
                + '<td>' + (r.source_url ? '<a target="_blank" rel="noopener" href="' + esc(r.source_url) + '">link</a>' : "—") + '</td></tr>';
            }).join("") + '</tbody></table>'
        : '<div class="ads-empty">No rounds on file.</div>');

    html += section("Investors (" + (p.investors || []).length + ")",
      (p.investors || []).length
        ? '<table class="ads-table"><thead><tr><th>Investor</th><th>Type</th><th>Stage</th><th>Amount</th><th>Lead?</th><th>Date</th></tr></thead><tbody>'
          + p.investors.map(function (i) {
              var nm = i.investor_lead_id
                ? '<a href="/dashboard/investors/detail/?id=' + esc(i.investor_lead_id) + '">' + esc(i.investor_name || i.investor_lead_id) + '</a>'
                : (i.firm_id ? esc(i.firm_name || ("firm #" + i.firm_id)) : "—");
              return '<tr><td>' + nm + '</td><td>' + esc(i.investor_kind || (i.firm_id ? "firm" : "—")) + '</td>'
                + '<td>' + esc(i.stage || "—") + '</td><td>' + fmtUsd(i.amount_usd) + '</td>'
                + '<td>' + (i.is_lead ? "Y" : "N") + '</td><td>' + esc(i.invested_at || "—") + '</td></tr>';
            }).join("") + '</tbody></table>'
        : '<div class="ads-empty">No investors on file.</div>');

    html += section("News & media (" + (p.news || []).length + ")",
      (p.news || []).length
        ? '<ul>' + p.news.map(function (n) {
            return '<li><a target="_blank" rel="noopener" href="' + esc(n.url) + '">' + esc(n.title || n.url) + '</a> <span class="ads-muted">— ' + esc(n.source || "") + ' · ' + esc(n.published_at || "") + '</span></li>';
          }).join("") + '</ul>'
        : '<div class="ads-empty">No news yet.</div>');

    html += section("Profiles & socials",
      '<table class="ads-table"><tbody>'
      + linkRow("Website", p.website, p.website)
      + linkRow("LinkedIn", profs.linkedin_url, profs.linkedin_url)
      + linkRow("Crunchbase", profs.crunchbase_url, profs.crunchbase_url)
      + linkRow("Twitter", profs.twitter_handle ? "https://twitter.com/" + profs.twitter_handle : null, profs.twitter_handle)
      + linkRow("GitHub", profs.github_org ? "https://github.com/" + profs.github_org : null, profs.github_org)
      + linkRow("Pitchbook", profs.pitchbook_url, profs.pitchbook_url)
      + linkRow("SEC CIK", profs.sec_cik ? "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + profs.sec_cik : null, profs.sec_cik)
      + '</tbody></table>');

    html += section("Change history (last 50)",
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

  function linkRow(label, href, txt) {
    if (!txt) return '<tr><th>' + esc(label) + '</th><td class="ads-muted">—</td></tr>';
    return '<tr><th>' + esc(label) + '</th><td><a target="_blank" rel="noopener" href="' + esc(href) + '">' + esc(txt) + '</a></td></tr>';
  }

  function wireActions(p) {
    var btn = document.getElementById("ads-co-enrich");
    if (!btn) return;
    btn.addEventListener("click", function () {
      btn.disabled = true; btn.textContent = "Queuing…";
      api("/api/companies/" + encodeURIComponent(p.id) + "/enrich", { method: "POST" })
        .then(function () { btn.textContent = "Queued ✓"; })
        .catch(function (e) { btn.textContent = "Failed: " + e.message; btn.disabled = false; });
    });
  }
})();
