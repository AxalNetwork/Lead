// Task #2: Fund profile page with tabbed sections (Overview, Portfolio,
// Modeled returns). Per the Task #4 static-routing constraint, URL is
// /dashboard/funds/detail/?id=<fund_id> (query string, not path segment).
(function () {
  var root = document.getElementById("ads-fund-detail");
  if (!root) return;
  var API_BASE = (window.ADS && window.ADS.apiBase);
  var fundId = new URLSearchParams(window.location.search).get("id");
  if (!fundId) {
    root.innerHTML = '<div class="ads-card"><p class="ads-muted">Missing <code>?id=&lt;fund_id&gt;</code>.</p></div>';
    return;
  }

  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  function fmtMoney(n){ if(n==null||!isFinite(n)) return "—"; if(Math.abs(n)>=1e9) return "$"+(n/1e9).toFixed(2)+"B"; if(Math.abs(n)>=1e6) return "$"+(n/1e6).toFixed(2)+"M"; if(Math.abs(n)>=1e3) return "$"+(n/1e3).toFixed(1)+"k"; return "$"+n; }
  function fmtX(n){ return n==null||!isFinite(n) ? "—" : Number(n).toFixed(2)+"x"; }
  function fmtPct(n){ return n==null||!isFinite(n) ? "—" : Number(n).toFixed(1)+"%"; }
  function api(path){ return window.adsUtil.request(API_BASE+path,{credentials:"include"}).then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); }); }

  var loaded = { overview:true };
  function activateTab(name){
    var tabs = root.querySelectorAll(".ads-tab");
    var panes = root.querySelectorAll("[data-pane]");
    var found = false;
    tabs.forEach(function(t){
      var on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      if (on) found = true;
    });
    if (!found) return;
    panes.forEach(function(p){ p.hidden = p.dataset.pane !== name; });
    if (!loaded[name]) { loaded[name] = true; if (name === "modeled-returns") loadModeled(); }
  }
  function setupTabs(){
    var tabs = root.querySelectorAll(".ads-tab");
    tabs.forEach(function(t){
      t.addEventListener("click", function(){ activateTab(t.dataset.tab); });
    });
    // Hash-based deep-link hydration: /dashboard/funds/detail/?id=…#modeled-returns
    // lands directly on the Modeled-returns tab. Preserves the legacy
    // /dashboard/fund-returns/?id=… redirect's intent.
    var hash = (location.hash || "").replace(/^#/, "");
    if (hash) activateTab(hash);
    window.addEventListener("hashchange", function(){
      var h = (location.hash || "").replace(/^#/, "");
      if (h) activateTab(h);
    });
  }

  function renderShell(fund){
    var tpl = document.getElementById("ads-fund-tpl");
    root.innerHTML = "";
    root.appendChild(tpl.content.cloneNode(true));
    setupTabs();
    var k = function(key){ return root.querySelector('[data-k="'+key+'"]'); };
    k("fund_name").textContent = fund.fund_name + (fund.fund_number ? " "+fund.fund_number : "");
    k("firm_name").textContent = fund.firm_name || "—";
    k("vintage_year").textContent = fund.vintage_year || "—";
    k("strategy").textContent = fund.strategy || "—";
    k("fund_status").textContent = fund.fund_status || "—";
    k("target_size").textContent = fmtMoney(fund.target_size_usd);
    k("o_vintage").textContent = fund.vintage_year || "—";
    k("o_strategy").textContent = fund.strategy || "—";
    k("o_target").textContent = fmtMoney(fund.target_size_usd);
    k("o_raised").textContent = fmtMoney(fund.announced_raised_usd);
    k("o_first_close").textContent = fund.first_close_date || "—";
    k("o_final_close").textContent = fund.final_close_date || "—";
    k("o_mgmt").textContent = fund.mgmt_fee_pct != null ? fund.mgmt_fee_pct+"%" : "—";
    k("o_carry").textContent = fund.carry_pct != null ? fund.carry_pct+"%" : "—";
  }

  function renderPortfolio(portfolio, summary){
    var rows = (portfolio||[]).map(function(p){
      return "<tr><td>"+esc(p.company_name)+"</td><td>"+esc(p.round_name||"")
        +"</td><td>"+fmtMoney(p.amount_usd)+"</td><td>"+esc(p.role||"")
        +"</td><td>"+esc(p.date||"")+"</td></tr>";
    }).join("") || "<tr><td colspan='5'>No positions.</td></tr>";
    document.getElementById("ads-portfolio-tbody").innerHTML = rows;
    if (summary) {
      document.getElementById("ads-portfolio-summary").textContent =
        (summary.position_count||0)+" positions · lead ratio "+fmtPct((summary.lead_ratio||0)*100)
        +" · check p50 "+fmtMoney(summary.check_size_p50_usd)
        +" · total invested "+fmtMoney(summary.total_check_usd);
    }
  }

  async function loadModeled(){
    try {
      var [m, a] = await Promise.all([
        api("/api/funds/"+encodeURIComponent(fundId)+"/modeled-returns?history=10"),
        api("/api/funds/"+encodeURIComponent(fundId)+"/modeled-returns/attribution"),
      ]);
      var pane = root.querySelector('[data-pane="modeled-returns"]');
      var qmr = function(s){ return pane.querySelector('[data-mr="'+s+'"]'); };
      var latest = m.latest;
      if (!latest) {
        qmr("coverage").textContent = "No model run yet. The nightly sweep runs at 03:15 UTC.";
        return;
      }
      qmr("dpi").textContent  = fmtX(latest.metrics.dpi);
      qmr("tvpi").textContent = fmtX(latest.metrics.tvpi);
      qmr("moic").textContent = fmtX(latest.metrics.moic);
      qmr("irr").textContent  = fmtPct(latest.metrics.net_irr_pct);
      qmr("conf").textContent = (latest.coverage.confidence||"low").toUpperCase();
      qmr("coverage").textContent =
        "Coverage: "+latest.coverage.positions_resolved+" / "+latest.coverage.positions_total
        +" positions resolved ("+Math.round((latest.coverage.resolved_coverage_pct||0)*100)+"%) · "
        +"called "+fmtMoney(latest.inputs.called_usd)
        +" · invested "+fmtMoney(latest.inputs.invested_usd)
        +" · distributed "+fmtMoney(latest.cashflows.distributed_usd)
        +" · residual "+fmtMoney(latest.cashflows.residual_value_usd)
        +" · bias "+(latest.calibration.bias_correction_applied!=null ? latest.calibration.bias_correction_applied.toFixed(2)+"x" : "1.00x");
      var dva = latest.calibration.delta_vs_actual;
      if (dva && (dva.tvpi || dva.dpi)) {
        var parts = [];
        if (dva.tvpi) parts.push("TVPI actual "+fmtX(dva.tvpi.actual)+" vs modeled "+fmtX(dva.tvpi.modeled)+" (Δ "+fmtX(dva.tvpi.delta).replace("x","")+")");
        if (dva.dpi)  parts.push("DPI actual "+fmtX(dva.dpi.actual)+" vs modeled "+fmtX(dva.dpi.modeled)+" (Δ "+fmtX(dva.dpi.delta).replace("x","")+")");
        qmr("delta").textContent = "LP-disclosed as of "+esc(dva.as_of||"")+": "+parts.join(" · ");
      } else {
        qmr("delta").textContent = "No LP-disclosed actuals to compare yet.";
      }
      var warns = latest.warnings || [];
      qmr("warnings").textContent = warns.length ? "Warnings: "+warns.join(", ") : "";

      var contribs = a.contributors || [];
      // Top-5 contribution chart: horizontal CSS bars sized as a
      // percentage of the leader's contribution so the visual remains
      // readable when share-of-total is tiny.
      var chart = document.getElementById("ads-attribution-chart");
      if (contribs.length) {
        var maxC = Math.max.apply(null, contribs.map(function(c){ return Math.max(0, c.contribution_usd||0); })) || 1;
        chart.innerHTML = contribs.slice(0,5).map(function(c){
          var pct = Math.max(0, Math.min(100, Math.round(((c.contribution_usd||0) / maxC) * 100)));
          var color = (c.event_kind === "bankruptcy") ? "#b33" :
                      (c.event_kind === "ipo") ? "#2a7" :
                      (c.event_kind === "acquisition" || c.event_kind === "merger") ? "#27a" : "#888";
          return '<div style="display:flex;align-items:center;gap:.5rem;margin:.25rem 0;font-size:12px">'
               + '<div style="flex:0 0 12rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
               + esc(c.company_name||"?")+' <span class="ads-muted">('+esc(c.event_kind||"")+')</span></div>'
               + '<div style="flex:1;background:#eee;border-radius:3px;height:14px;position:relative">'
               +   '<div style="width:'+pct+'%;background:'+color+';height:100%;border-radius:3px"></div>'
               + '</div>'
               + '<div class="ads-mono" style="flex:0 0 7rem;text-align:right">'+fmtMoney(c.contribution_usd)+'</div>'
               + '<div class="ads-mono" style="flex:0 0 3rem;text-align:right">'+Math.round((c.share_pct||0)*100)+'%</div>'
               + '</div>';
        }).join("");
      } else {
        chart.innerHTML = '<div class="ads-muted" style="font-size:12px">No resolved contributors yet.</div>';
      }
      document.getElementById("ads-attribution-tbody").innerHTML = (contribs.length ? contribs : []).map(function(c){
        return "<tr><td>"+esc(c.company_name||"")+"</td><td>"+esc(c.event_kind||"")
          +"</td><td>"+fmtMoney(c.contribution_usd)+"</td><td>"+Math.round((c.share_pct||0)*100)+"%</td></tr>";
      }).join("") || "<tr><td colspan='4'>No resolved contributors.</td></tr>";

      var hist = m.history || [];
      document.getElementById("ads-history-tbody").innerHTML = hist.map(function(h){
        return "<tr><td>"+esc(h.as_of||"")+"</td><td>"+fmtX(h.metrics.dpi)+"</td><td>"+fmtX(h.metrics.tvpi)
          +"</td><td>"+fmtX(h.metrics.moic)+"</td><td>"+esc(h.coverage.confidence||"")
          +"</td><td>"+Math.round((h.coverage.resolved_coverage_pct||0)*100)+"%</td></tr>";
      }).join("") || "<tr><td colspan='6'>No history.</td></tr>";
    } catch(e){
      var pane = root.querySelector('[data-pane="modeled-returns"]');
      if (pane) pane.querySelector('[data-mr="coverage"]').textContent = "Modeled-returns unavailable: "+e.message;
    }
  }

  (async function init(){
    try {
      var r = await api("/api/funds/"+encodeURIComponent(fundId));
      var fund = r.fund || {};
      renderShell(fund);
      renderPortfolio(r.portfolio, r.portfolio_summary);
    } catch(e) {
      root.innerHTML = '<div class="ads-card"><p class="ads-muted">Fund unavailable: '+esc(e.message)+'</p></div>';
    }
  })();
})();
