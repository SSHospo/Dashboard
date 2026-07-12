// employmenthero.js — optional rostering adapter. Adds exactly one thing to
// the board: a *projected* Wage % (rostered cost ÷ revenue), always shown
// labelled "projected" beside the real, Xero-sourced Wage %. If this is
// never connected, nothing on the core board is lost — see kpi-spec.md.
//
// Employment Hero is NOT one of this kit's pre-verified rostering
// walk-throughs (Deputy/Tanda/Urhere) — this file was built by running the
// generic "any other tool" triage (capability-matrix.md) and checking
// Employment Hero's current developer docs directly, verified July 2026.
//
// CONFIRMED against developer.employmenthero.com/api-references and
// /partner-guides at build time:
//   - OAuth 2.0 authorization-code flow.
//   - Authorize:  https://oauth.employmenthero.com/oauth2/authorize
//   - Token:      https://oauth.employmenthero.com/oauth2/token
//   - API base:   https://api.employmenthero.com
//   - Access tokens expire after 15 minutes — refresh aggressively, same
//     pattern as getValidXeroAccessToken in worker.js.
//   - Redirect URIs must be HTTPS. No other restriction documented.
//   - Full permanent access (beyond a 2-week trial) requires Employment
//     Hero's manual approval (email partner@employmenthero.com) — this is a
//     genuinely gated step, unlike Xero/Square's instant self-serve apps.
//   - The HR platform's rostered_shifts endpoint additionally requires a
//     Platinum-tier subscription or higher.
//
// NOT YET CONFIRMED (do not trust until checked against a real connected
// account — see fetchRosterCost below):
//   - The exact OAuth scope name(s) needed for roster/shift read access.
//     Employment Hero's own docs say the scope list is presented to you at
//     app-creation time in their Developer Portal, not published as a fixed
//     catalogue — read whatever the scope picker shows when creating the
//     app and request the narrowest read-only set offered.
//   - Whether the token endpoint wants client_id/client_secret as HTTP
//     Basic auth (like Xero) or in the POST body (client_secret_post, the
//     more common OAuth2 default). This file defaults to body params;
//     if exchangeCode() fails with 401, that's the first thing to try
//     switching (see basicAuthHeader below, currently unused).
//   - The exact shape of the rostered_shifts response, and whether a cost
//     figure is present on it at all (Employment Hero's own help docs
//     describe roster costing as an in-app UI calculation, not clearly as
//     an API field) — fetchRosterCost() is deliberately left unimplemented
//     until we've seen one real response from the owner's connected
//     account. Wire it in then; do not guess field names here.

const AUTHORIZE_URL = "https://oauth.employmenthero.com/oauth2/authorize";
const TOKEN_URL = "https://oauth.employmenthero.com/oauth2/token";
const API_BASE = "https://api.employmenthero.com";

// BUG FOUND 12 Jul 2026, first live connection attempt: this used to send a
// literal placeholder string ("TODO_CONFIRM_SCOPES_AT_APP_CREATION") as the
// scope parameter on every real authorize request — a real mistake, not a
// deliberate default. Employment Hero's docs say scopes are fixed once at
// app-creation time in the Developer Portal (not requested dynamically per
// the OAuth authorize call, unlike Xero), so the correct move is to send no
// scope param at all and let the app's own configured scopes apply. Sending
// that placeholder is the leading suspect for why the resulting access
// token could read rostered_shifts fine but got "insufficient_scope" on the
// cost endpoints (/rostered_shifts/{id}/cost, /shift_costs) despite "Shift
// cost: Read" being ticked at app creation, and despite the connecting
// account being confirmed full admin — ruling out a permissions cause.
export function buildAuthorizeUrl(env, redirectUri, state) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.EMPLOYMENT_HERO_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

// Unused by default — see the token-endpoint auth note above. Kept ready in
// case exchangeCode/refreshTokens need to switch from body-param auth to
// HTTP Basic (Xero needed Basic; do not assume Employment Hero is the same
// without testing).
function basicAuthHeader(env) {
  return "Basic " + btoa(`${env.EMPLOYMENT_HERO_CLIENT_ID}:${env.EMPLOYMENT_HERO_CLIENT_SECRET}`);
}

export async function exchangeCode(env, code, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: env.EMPLOYMENT_HERO_CLIENT_ID,
      client_secret: env.EMPLOYMENT_HERO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`employment hero token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function refreshTokens(env, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.EMPLOYMENT_HERO_CLIENT_ID,
      client_secret: env.EMPLOYMENT_HERO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`employment hero token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * List the organisations this connection can see — used once after connecting
 * so the owner can confirm it's their real business (same "which tenant"
 * confirm step as Xero), and to get the organisation_id the roster endpoint
 * needs. Endpoint path is the one documented pattern
 * (api.employmenthero.com/api/v1/organisations) — verify the response shape
 * against the real connected account before relying on field names beyond
 * id/name.
 */
export async function listOrganisations(accessToken) {
  const res = await fetch(`${API_BASE}/api/v1/organisations`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`employment hero organisations lookup failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * NOT YET IMPLEMENTED. Rostered-shift cost for [startISO, endISO) is the one
 * number this adapter owes the board (kpi-spec.md: projected Wage % =
 * rostered cost ÷ revenue). Two real gaps stand between here and that number:
 *
 *   1. It's unconfirmed whether Employment Hero's rostered_shifts endpoint
 *      (HR API) returns a cost figure at all, versus only shift times — in
 *      which case cost would need computing from hours × the employee's pay
 *      rate, and it's unconfirmed whether pay rate is exposed via this API
 *      or needs the separate Payroll (ex-KeyPay) API's per-shift costing
 *      endpoint instead (one call per shift, not a bulk range call).
 *   2. Which of the two APIs (and which base URL/auth) actually applies
 *      depends on the owner's Employment Hero plan and whether payroll runs
 *      through Employment Hero or elsewhere (confirmed: elsewhere, Xero).
 *
 * Once connected, call listOrganisations() and one raw shift-list request,
 * look at the real JSON, and finish this function against what's actually
 * there — do not guess field names ahead of that.
 */
export async function fetchRosterCost(/* accessToken, organisationId, startISO, endISO */) {
  throw new Error(
    "employment hero roster-cost fetch not wired yet — needs a real API response to build against, see comment above fetchRosterCost"
  );
}
