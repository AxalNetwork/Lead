export function renderLanding(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Data Signal — Lead intelligence, on autopilot</title>
<meta name="description" content="AI Data Signal turns the open web into a private, verified pipeline of qualified leads. Single-operator admin platform.">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#070b1c;--panel:#0f1530;--panel-2:#1a2347;--border:#243066;
    --text:#e6ebff;--muted:#8b94c2;--accent:#5b8cff;--accent-2:#23d6a4;
  }
  html,body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}
  .nav{display:flex;align-items:center;justify-content:space-between;padding:22px 32px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(7,11,28,.85);backdrop-filter:blur(8px);z-index:10}
  .brand{font-weight:700;font-size:18px;color:#fff;letter-spacing:.4px;display:flex;align-items:center;gap:10px}
  .brand-dot{width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 0 12px rgba(91,140,255,.6)}
  .nav-actions{display:flex;gap:12px;align-items:center}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;border:none;cursor:pointer;transition:.15s}
  .btn-primary{background:linear-gradient(135deg,var(--accent),#3a6bff);color:#fff}
  .btn-primary:hover{filter:brightness(1.1);color:#fff;transform:translateY(-1px)}
  .btn-ghost{background:transparent;color:var(--text);border:1px solid var(--border)}
  .btn-ghost:hover{background:var(--panel);color:#fff}
  .hero{max-width:980px;margin:0 auto;padding:90px 32px 60px;text-align:center}
  .eyebrow{display:inline-block;padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:var(--panel);color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:28px}
  h1{font-size:56px;line-height:1.1;font-weight:700;color:#fff;letter-spacing:-1px;margin-bottom:24px}
  h1 .grad{background:linear-gradient(135deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .lede{font-size:19px;color:var(--muted);max-width:680px;margin:0 auto 36px}
  .cta{display:flex;justify-content:center;gap:14px;flex-wrap:wrap}
  .features{max-width:1100px;margin:30px auto 80px;padding:0 32px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
  @media(max-width:880px){.features{grid-template-columns:1fr}h1{font-size:38px}.lede{font-size:17px}}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:28px}
  .card h3{color:#fff;font-size:16px;font-weight:600;margin-bottom:10px;display:flex;align-items:center;gap:10px}
  .card-icon{width:30px;height:30px;border-radius:8px;background:var(--panel-2);display:inline-flex;align-items:center;justify-content:center;color:var(--accent);font-size:16px}
  .card p{color:var(--muted);font-size:14px}
  .signin-section{max-width:560px;margin:0 auto 100px;padding:36px;border:1px solid var(--border);border-radius:14px;background:var(--panel);text-align:center}
  .signin-section h2{font-size:22px;color:#fff;margin-bottom:10px}
  .signin-section p{color:var(--muted);font-size:14px;margin-bottom:22px}
  .signin-note{font-size:12px;color:var(--muted);margin-top:18px}
  footer{border-top:1px solid var(--border);padding:24px 32px;text-align:center;color:var(--muted);font-size:13px}
</style>
</head>
<body>
<nav class="nav">
  <div class="brand"><span class="brand-dot"></span> AI Data Signal</div>
  <div class="nav-actions">
    <a href="#how" class="btn btn-ghost">How it works</a>
    <a href="https://app.aidatasignal.com" class="btn btn-primary">Sign in</a>
  </div>
</nav>

<section class="hero">
  <span class="eyebrow">Single-operator lead intelligence</span>
  <h1>Turn the open web into a <span class="grad">verified pipeline</span> of leads.</h1>
  <p class="lede">AI Data Signal continuously scrapes, enriches, deduplicates and verifies leads from the sources you choose — then surfaces the high-confidence ones in a private dashboard for human approval and export.</p>
  <div class="cta">
    <a href="https://app.aidatasignal.com" class="btn btn-primary">Open dashboard →</a>
    <a href="#how" class="btn btn-ghost">See how it works</a>
  </div>
</section>

<section id="how" class="features">
  <div class="card">
    <h3><span class="card-icon">⚙</span> Scrape jobs</h3>
    <p>Configure source domains and run scheduled crawls. Each job streams results to a queue for enrichment.</p>
  </div>
  <div class="card">
    <h3><span class="card-icon">✓</span> Verification</h3>
    <p>Every lead is normalized, deduplicated and verified (email, domain, signal score) before it lands in the review queue.</p>
  </div>
  <div class="card">
    <h3><span class="card-icon">↗</span> Approve &amp; export</h3>
    <p>Triage in the dashboard, approve what matters, export to CSV. Full analytics on volume, sources and conversion.</p>
  </div>
</section>

<section class="signin-section">
  <h2>Operator access only</h2>
  <p>This platform is private and gated by Cloudflare Access. Sign-in uses a one-time passcode emailed to the allowlisted operator address.</p>
  <a href="https://app.aidatasignal.com" class="btn btn-primary">Sign in to dashboard →</a>
  <div class="signin-note">You'll be asked for your email and a 6-digit code Cloudflare emails you.</div>
</section>

<footer>
  © ${new Date().getFullYear()} AI Data Signal · <a href="mailto:guillaumelauzier@gmail.com">contact</a>
</footer>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}
