// Task #2: "Where is X?" persistent helper widget.
//
// One-paragraph explainer + "Take me there" deep links to People,
// Leads, and Imports filtered by the signed-in user's email.
// Dismissible (localStorage flag). Reads only data already on the
// page (the user email is exposed via #ads-user-avatar[data-user-email]
// by dashboard.js); never issues an API call.
(function () {
  if (typeof document === "undefined") return;
  var DISMISS_KEY = "ads.widgets.where_is_x.dismissed";
  function userEmail() {
    var el = document.getElementById("ads-user-avatar");
    return (el && el.getAttribute("data-user-email")) || "";
  }
  function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch (e) { return false; }
  }
  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch (e) { /* ignore */ }
    var el = document.getElementById("ads-where-is-x");
    if (el) el.remove();
  }
  function mount() {
    if (dismissed()) return;
    // Avoid rendering on the public-marketing layout (no dashboard shell).
    if (!document.getElementById("ads-shell")) return;
    if (document.getElementById("ads-where-is-x")) return;
    var email = userEmail();
    var enc = encodeURIComponent(email || "");
    var widget = document.createElement("aside");
    widget.id = "ads-where-is-x";
    widget.setAttribute("role", "complementary");
    widget.setAttribute("aria-label", "Where is X? — finding your uploaded records");
    widget.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:50",
      "max-width:340px",
      "background:var(--ads-bg-2,#1a1a1a)",
      "border:1px solid var(--ads-border,#333)",
      "border-radius:10px",
      "padding:12px 14px",
      "box-shadow:0 6px 24px rgba(0,0,0,0.35)",
      "font-size:12px",
      "line-height:1.45",
      "color:var(--ads-text,#eaeaea)",
    ].join(";");
    widget.innerHTML = ""
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
      + '<strong style="font-size:12px">Where is X?</strong>'
      + '<button type="button" id="ads-where-is-x-dismiss" aria-label="Dismiss" '
      + 'style="background:none;border:0;color:inherit;cursor:pointer;font-size:14px;line-height:1">×</button>'
      + '</div>'
      + '<p style="margin:0 0 8px 0">Leads you upload land in <strong>People</strong> and also appear in '
      + '<strong>Investors</strong>, <strong>Customers</strong>, <strong>Prospects</strong>, '
      + 'or <strong>Leads</strong> depending on the role chips assigned to them. Promoted entities drop off the Leads list automatically.</p>'
      + '<div style="display:flex;flex-wrap:wrap;gap:6px">'
      + '<a class="ads-btn ads-btn--sm" href="/dashboard/people/' + (email ? '?source_email=' + enc : '') + '">People</a>'
      + '<a class="ads-btn ads-btn--sm ads-btn--ghost" href="/dashboard/leads/' + (email ? '?owner_email=' + enc : '') + '">Leads</a>'
      + '<a class="ads-btn ads-btn--sm ads-btn--ghost" href="/dashboard/imports/' + (email ? '?owner_email=' + enc : '') + '">Imports</a>'
      + '</div>';
    document.body.appendChild(widget);
    var btn = document.getElementById("ads-where-is-x-dismiss");
    if (btn) btn.addEventListener("click", dismiss);
  }
  // Mount once DOM is ready AND after dashboard.js has had a chance
  // to stamp the user-email attribute. A small deferred mount is
  // sufficient (dashboard.js runs sync on DOMContentLoaded).
  function boot() { setTimeout(mount, 300); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
