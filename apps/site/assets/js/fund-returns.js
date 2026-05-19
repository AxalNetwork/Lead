// Task #2: Fund-Return Modeling UI.
// Static-routing constraint (per replit.md Task #4): uses ?id=<fund_id>
// rather than /:id path segment because Jekyll on GitHub Pages serves
// only prebuilt static paths.
(async function(){
  var ok = await adsDashboards.gate("fund-returns"); if(!ok) return;
  var d = adsDashboards;

  function fmt(n, suffix){ if(n==null||!isFinite(n)) return "—"; return Number(n).toFixed(2)+(suffix||""); }
  function fmtUsd(n){ return n==null ? "—" : d.fmtUsd(n); }

  async function load(fundId){
    document.getElementById("fund-id").value = fundId;
    try {
      var [m, a] = await Promise.all([
        d.api("/funds/"+encodeURIComponent(fundId)+"/modeled-returns?history=10"),
        d.api("/funds/"+encodeURIComponent(fundId)+"/modeled-returns/attribution"),
      ]);
      var latest = m.latest;
      if (!latest) {
        document.getElementById("returns-panel").style.display = "block";
        document.getElementById("m-dpi").textContent = "—";
        document.getElementById("m-coverage").textContent = "No model run yet. Run the nightly sweep or wait for 03:15 UTC.";
        return;
      }
      document.getElementById("returns-panel").style.display = "block";
      document.getElementById("m-dpi").textContent  = fmt(latest.metrics.dpi, "x");
      document.getElementById("m-tvpi").textContent = fmt(latest.metrics.tvpi, "x");
      document.getElementById("m-moic").textContent = fmt(latest.metrics.moic, "x");
      document.getElementById("m-irr").textContent  = fmt(latest.metrics.net_irr_pct, "%");
      document.getElementById("m-conf").textContent = (latest.coverage.confidence||"low").toUpperCase();
      document.getElementById("m-coverage").textContent =
        "Coverage: " + latest.coverage.positions_resolved + " / " + latest.coverage.positions_total +
        " positions resolved (" + Math.round((latest.coverage.resolved_coverage_pct||0)*100) + "%) · " +
        "called " + fmtUsd(latest.inputs.called_usd) + " · invested " + fmtUsd(latest.inputs.invested_usd) +
        " · distributed " + fmtUsd(latest.cashflows.distributed_usd) +
        " · residual " + fmtUsd(latest.cashflows.residual_value_usd) +
        " · bias " + (latest.calibration.bias_correction_applied!=null ? latest.calibration.bias_correction_applied.toFixed(2)+"x" : "1.00x");
      var warns = latest.warnings || [];
      document.getElementById("m-warnings").textContent = warns.length ? "Warnings: " + warns.join(", ") : "";

      // Attribution
      var contribs = a.contributors || [];
      document.getElementById("attribution-panel").style.display = "block";
      document.getElementById("attribution-tbody").innerHTML = (contribs.length ? contribs : []).map(function(c){
        return "<tr><td>"+d.esc(c.company_name||"")+"</td><td>"+d.esc(c.event_kind||"")
          +"</td><td>"+fmtUsd(c.contribution_usd)+"</td><td>"+Math.round((c.share_pct||0)*100)+"%</td></tr>";
      }).join("") || "<tr><td colspan='4'>No resolved contributors.</td></tr>";

      // History
      var hist = m.history || [];
      document.getElementById("history-panel").style.display = "block";
      document.getElementById("history-tbody").innerHTML = hist.map(function(h){
        return "<tr><td>"+d.esc(h.as_of||"")+"</td><td>"+fmt(h.metrics.dpi,"x")+"</td><td>"+fmt(h.metrics.tvpi,"x")
          +"</td><td>"+fmt(h.metrics.moic,"x")+"</td><td>"+d.esc(h.coverage.confidence||"")
          +"</td><td>"+Math.round((h.coverage.resolved_coverage_pct||0)*100)+"%</td></tr>";
      }).join("") || "<tr><td colspan='6'>No history.</td></tr>";
    } catch(e){ console.warn(e); alert("Load failed: "+e.message); }
  }

  document.getElementById("fund-form").addEventListener("submit", function(e){
    e.preventDefault();
    var id = document.getElementById("fund-id").value.trim();
    if (id) { var u = new URL(location.href); u.searchParams.set("id", id); history.replaceState({}, "", u); load(id); }
  });

  var params = new URLSearchParams(location.search);
  var id = params.get("id");
  if (id) load(id);
})();
