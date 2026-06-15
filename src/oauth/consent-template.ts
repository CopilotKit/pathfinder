// src/oauth/consent-template.ts
//
// Server-rendered consent screen for the OAuth `/authorize` flow.
//
// Design constraints (spec §1):
//   * Pure function — no Express/req/res imports, no I/O.
//   * Single self-contained HTML document, inline CSS only, NO `<script>` tags.
//     This page is part of a phishing-defense flow; introducing JS would expand
//     attack surface and we render fine without it (submit buttons drive the form).
//   * Every interpolated value HTML-escapes both as text and attribute content.
//     Sources arrive from arbitrary client registrations + query strings — never
//     trust them.
//   * The redirect_uri HOSTNAME is the dominant visual element. Users authorize
//     a destination, so the destination must be unmistakable. The full URI is
//     also shown verbatim so a phisher cannot smuggle a deceptive path.
//   * Hidden inputs MUST cover the entire HMAC-bound set so the POST round-trip
//     re-emits exactly what was signed; the consent handler re-verifies on receipt.
//
// The page is ALSO served under a strict Content-Security-Policy enforced at
// the handler layer (`handlers.ts` authorizeHandler): `default-src 'none';
// style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none';
// base-uri 'none'` — i.e. no `<script>`, no external stylesheets, no remote
// images, no iframing, no `<base>` rebasing of the form's action. The "no JS"
// invariant in this template is belt-and-suspenders against that CSP; both
// must hold for the phishing-defense guarantees to make sense.
//
// Trying to add a `<script>` tag, an external stylesheet, or anything that bypasses
// the escaper is a regression — the test suite asserts the negative case.

/**
 * Escape a string for safe HTML insertion in either text-node or
 * double-quoted-attribute context. Order matters: `&` first, otherwise we
 * double-escape the entities we then emit.
 *
 * `'` is encoded as `&#39;` rather than `&apos;` for IE compat (irrelevant
 * today but harmless and matches the rest of the codebase's escaping style).
 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ConsentRenderArgs {
  /** Display name from client registration. Already truncated to 80 chars upstream. */
  clientName: string;
  /** Stable client identifier (UUID). Shown as fallback when `clientName` is empty. */
  clientId: string;
  /** Full redirect_uri the authorization code will be sent to. */
  redirectUri: string;
  /** Hostname component of `redirectUri`, surfaced as the dominant visual element. */
  redirectUriHostname: string;
  /** Requested OAuth scope string. */
  scope: string;
  /** Opaque client state echoed back on redirect. */
  state: string;
  /** PKCE code_challenge value. */
  codeChallenge: string;
  /** PKCE method, typically `S256`. */
  codeChallengeMethod: string;
  /** OAuth response_type, typically `code`. */
  responseType: string;
  /** Optional RFC 8707 resource indicator. Empty string when unused. */
  resource: string;
  /** HMAC-signed consent nonce re-verified by the consent handler. */
  nonce: string;
}

export function renderConsentHtml(a: ConsentRenderArgs): string {
  // If a client registered without a name, show the opaque client_id rather
  // than a blank header — at least gives the user *something* identifying.
  const displayName = a.clientName.length > 0 ? a.clientName : a.clientId;
  const e = escHtml;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access to CopilotKit MCP</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 520px; margin: 4rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 18px; margin-bottom: 1.5rem; }
  .name { font-size: 22px; font-weight: 700; margin: 0.25rem 0; }
  .host { font-size: 18px; margin: 0.75rem 0 0.25rem; }
  .host strong { font-size: 22px; }
  code { display: block; padding: 0.5rem; background: #f4f4f5; border-radius: 4px; word-break: break-all; font-size: 13px; }
  .scope { margin-top: 1rem; color: #555; }
  .warn { margin-top: 1.25rem; padding: 0.75rem; background: #fef3c7; border-radius: 4px; font-size: 13px; }
  .row { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
  button { padding: 0.5rem 1rem; font-size: 14px; cursor: pointer; border-radius: 4px; }
  button.primary { background: #111; color: #fff; border: 0; }
  button.secondary { background: #fff; color: #111; border: 1px solid #d4d4d8; }
</style>
</head><body>
<h1>Authorize access to CopilotKit MCP</h1>
<p class="name">${e(displayName)}</p>
<p>is requesting access. After approval you will be redirected to:</p>
<p class="host"><strong>${e(a.redirectUriHostname)}</strong></p>
<code>${e(a.redirectUri)}</code>
<p class="scope">Scope: <strong>${e(a.scope)}</strong></p>
<p class="warn">Only approve if you recognize this application and the hostname above.</p>
<form method="POST" action="/authorize/consent">
  <input type="hidden" name="nonce" value="${e(a.nonce)}">
  <input type="hidden" name="client_id" value="${e(a.clientId)}">
  <input type="hidden" name="redirect_uri" value="${e(a.redirectUri)}">
  <input type="hidden" name="state" value="${e(a.state)}">
  <input type="hidden" name="code_challenge" value="${e(a.codeChallenge)}">
  <input type="hidden" name="code_challenge_method" value="${e(a.codeChallengeMethod)}">
  <input type="hidden" name="response_type" value="${e(a.responseType)}">
  <input type="hidden" name="scope" value="${e(a.scope)}">
  <input type="hidden" name="resource" value="${e(a.resource)}">
  <div class="row">
    <button class="primary" type="submit" name="decision" value="approve">Approve</button>
    <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>
</body></html>`;
}
