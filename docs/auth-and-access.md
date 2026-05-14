# Auth & Access

This platform uses **Cloudflare Access** as the single authentication layer for both the dashboard and the API. There is no in-app login form; Cloudflare handles the entire auth flow.

## How it works

1. User browses to `https://app.aidatasignal.com` or `https://api.aidatasignal.com`.
2. Cloudflare Access intercepts the request and (if no valid session cookie) redirects to `https://axalnetwork.cloudflareaccess.com`.
3. User enters their email; Access emails them a one-time PIN.
4. The Allow policy checks the email against the allowlist (`guillaumelauzier@gmail.com` only).
5. On success, Access issues a 24-hour session cookie scoped to `aidatasignal.com` and a signed JWT in the `Cf-Access-Jwt-Assertion` header on every upstream request.

## Worker verification

The Worker independently verifies the JWT on every `/api/*` request via `src/middleware/access.ts`. This is **defense in depth** — even if an attacker bypassed the edge gate, the Worker would reject unauthenticated requests.

JWT verification:
- Fetches JWKS from `https://axalnetwork.cloudflareaccess.com/cdn-cgi/access/certs` (cached 1h)
- Verifies RS256 signature
- Checks `aud` matches `ACCESS_AUD` env var (the app's AUD tag)
- Checks `iss` matches the team domain
- Checks `exp` not expired
- Checks `email` claim equals `ALLOWED_EMAIL` env var

## Cloudflare resources (already provisioned)

| Resource | Value |
|---|---|
| Account ID | `30c9362191318777b71647145decda48` |
| Zone | `aidatasignal.com` (`696c7cc93293750db3fca9aa3015eceb`) |
| Zero Trust org | `axalnetwork.cloudflareaccess.com` |
| OTP Identity Provider ID | `2d4da1a1-ae2d-434f-b38a-d6b1bf3d7e30` |
| Access App ID (api) | `7bfdd50e-d205-4d09-84bf-77da0ee7b79e` |
| Access App AUD (api) | `f9cbce05165afb5af93e5929ff93dc4591aa18cd8234244327e78fd29fa849dd` |
| Allow Policy ID (api) | `7dc76a7c-4593-4c43-b444-73ffb5d20fdb` |
| Allowed email | `guillaumelauzier@gmail.com` |

## Sign out

Visit `https://axalnetwork.cloudflareaccess.com/cdn-cgi/access/logout` to clear the session cookie. The dashboard's "Sign out" link in the top-right does the same.

## Bypassing for local development

When developing the Worker locally with `wrangler dev`, the Access middleware will reject all requests because there is no valid JWT. Two options:

1. **Generate a service token** in Zero Trust dashboard and add it as a policy include (read-only for testing).
2. **Add a `BYPASS_ACCESS=true` env var** check in `accessGuard` for local dev only — *not committed*.

## Key environment variables (set in `wrangler.toml`)

```toml
ALLOWED_EMAIL = "guillaumelauzier@gmail.com"
ACCESS_TEAM_DOMAIN = "axalnetwork.cloudflareaccess.com"
ACCESS_AUD = "f9cbce05165afb5af93e5929ff93dc4591aa18cd8234244327e78fd29fa849dd"
```
