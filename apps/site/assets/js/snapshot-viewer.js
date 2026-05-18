// Task #4: dashboard snapshot viewer. Loads /api/dashboards/snapshots/:id
// and hydrates the page STRICTLY from the immutable payload — never
// re-queries the underlying tables (acceptance probe #6). The id and
// page name come from the query string (?id=…&page=…) since Jekyll
// can't serve dynamic path segments.
(function () {
  function qsParam(name) {
    var m = new URLSearchParams(window.location.search);
    return m.get(name);
  }
  function show(id) { var el = document.getElementById(id); if (el) el.hidden = false; }
  function hide(id) { var el = document.getElementById(id); if (el) el.hidden = true; }
  function esc(s) { return (window.adsDashboards ? window.adsDashboards.esc(s) : String(s||"")); }

  async function load() {
    var id = qsParam("id");
    if (!id) { hide("snap-auth"); show("snap-missing"); return; }
    try {
      var data = await window.adsDashboards.api("/snapshots/" + encodeURIComponent(id));
      hide("snap-auth");
      var labelEl = document.getElementById("snap-page-label");
      labelEl.textContent = data.page;
      document.getElementById("snap-meta").textContent =
        " · " + data.row_count + " rows · captured " + (data.created_at || "");
      document.getElementById("snap-filters").textContent = JSON.stringify(data.filters || {}, null, 2);
      renderPayload(data.page, data.payload);
      show("snap-content");
    } catch (e) {
      hide("snap-auth");
      if (String(e.message).indexOf("forbidden") >= 0) show("snap-forbidden");
      else show("snap-missing");
    }
  }

  function renderPayload(page, payload) {
    var el = document.getElementById("snap-render");
    if (!payload) { el.innerHTML = '<div class="ads-empty">Empty payload.</div>'; return; }
    var d = window.adsDashboards;
    var charts = d.charts;
    // Dispatch on dashboard page kind. Each branch renders strictly
    // from `payload` — no fetch back to the source tables.
    switch (page) {
      case "capital-markets": {
        if (payload.dryPowder && charts.bubble) {
          charts.bubble(el, payload.dryPowder.items || [], { sizeKey: "dry_powder_usd", labelKey: "firm_name" });
        } else { el.innerHTML = renderItemsTable(payload.items || []); }
        return;
      }
      case "funds-raising":
        el.innerHTML = renderItemsTable(payload.items || [], ["firm_name","fund_name","vintage_year","target_size_usd","pct_raised","strategy"]); return;
      case "lp-network":
        if (charts.sankey) {
          var links = (payload.edges||[]).map(function (e) {
            return { from_firm_entity_id: e.lp_name||e.lp_entity_id, to_firm_entity_id: e.fund_name||e.fund_name_raw, count: Math.max(1, Math.round((e.committed_usd||0)/1e6)) };
          });
          charts.sankey(el, links, {});
        } else el.innerHTML = renderItemsTable(payload.edges || []);
        return;
      case "partner-moves":
        if (charts.sankey) charts.sankey(el, payload.links || [], {});
        else el.innerHTML = renderItemsTable(payload.items || []);
        return;
      case "vintage-benchmarks":
        if (charts.boxPlot) charts.boxPlot(el, payload.items || [], {});
        else el.innerHTML = renderItemsTable(payload.items || []);
        return;
      case "sector-momentum":
        if (charts.heatmap) charts.heatmap(el, payload.items || [], {});
        else el.innerHTML = renderItemsTable(payload.items || []);
        return;
      case "geographic-flow":
        if (charts.worldArcs) charts.worldArcs(el, payload.items || [], {});
        else el.innerHTML = renderItemsTable(payload.items || []);
        return;
      case "angel-finder":
        el.innerHTML = renderItemsTable(payload.items || [], ["person_name","angel_type","day_job_firm_name","portfolio_count","syndicate_handle"]); return;
      default:
        el.innerHTML = renderItemsTable(payload.items || []); return;
    }
  }

  function renderItemsTable(items, headers) {
    if (!items.length) return '<div class="ads-empty">No rows in this snapshot.</div>';
    var heads = headers || Object.keys(items[0]);
    var thead = '<tr>' + heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join("") + '</tr>';
    var body = items.slice(0, 200).map(function (r) {
      return '<tr>' + heads.map(function (h) { return '<td>' + esc(r[h] == null ? "" : r[h]) + '</td>'; }).join("") + '</tr>';
    }).join("");
    var more = items.length > 200 ? '<div class="ads-mono">+ ' + (items.length - 200) + ' more rows in payload</div>' : "";
    return '<div class="ads-table-wrap"><table class="ads-table"><thead>' + thead + '</thead><tbody>' + body + '</tbody></table></div>' + more;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else { load(); }
})();
