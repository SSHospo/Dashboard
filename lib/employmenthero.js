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
// CONFIRMED against developer.employmenthero.com/api-references and a real
// connected account:
//   - OAuth 2.0 authorization-code flow.
//   - Authorize:  https://oauth.employmenthero.com/oauth2/authorize
//   - Token:      https://oauth.employmenthero.com/oauth2/token
//   - API base:   https://api.employmenthero.com
//   - Access tokens expire after 15 minutes — refresh aggressively, same
//     pattern as getValidXeroAccessToken in worker.js.
//   - Scopes are fixed once, permanently, at Developer Portal app-creation
//     time — NOT requested per OAuth call via a scope= param (unlike Xero).
//     Only three scopes are granted on this app: Rostered shifts (Read),
//     Organisations (Read). ("Shift cost" was deliberately NOT granted —
//     see fetchRosteredShifts below for why that's fine.)
//   - rostered_shifts needs from_date/to_date as full ISO 8601 UTC
//     datetimes (plain YYYY-MM-DD returns 422). Paginated, 20/page.
//
// NOT pursued, and why: the dedicated cost endpoints (/shift_costs,
// /rostered_shifts/{id}/cost) return 403 insufficient_scope no matter what —
// tried with a full-admin account and a genuinely fresh app/authorization.
// Likely needs the "Pay details" scope (individual pay rates) under the
// hood, which the owner chose not to grant — pay rate is materially more
// sensitive than shift schedules. So this adapter only ever reads shift
// *times*, and the worker computes a projected cost itself from those hours
// using the owner's own award-rate setup (see lib/awardRates.js) — no
// individual pay-rate data ever needs to leave Employment Hero.

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

// CONFIRMED (against a real connected account, 12 Jul 2026): the "Shift
// cost" API scope returns 403 insufficient_scope no matter what — even with
// a brand-new app, a genuinely fresh authorization, and a full-admin
// connecting account. Working theory (Employment Hero's own help docs):
// shift cost needs pay-rate data behind the scenes, which needs the more
// sensitive "Pay details" scope — the owner chose not to grant that. So this
// adapter does NOT fetch cost from Employment Hero at all. Instead it fetches
// just the shift *schedule* (start/end times, who, where) — which works
// fine with only the Rostered shifts + Organisations scopes — and the
// worker computes a projected cost itself from hours × the owner's own
// award-rate setup (see lib/awardRates.js). See build-notes.md in the
// project for the full trail if this ever needs revisiting.
//
// CONFIRMED response shape: GET /api/v1/organisations/{orgId}/rostered_shifts
// with from_date/to_date as full ISO 8601 UTC datetimes (not plain dates —
// those 422). Paginated: { data: { items: [...], item_per_page, page_index,
// total_pages, total_items } }. Shift item fields actually seen: id,
// start_time, end_time, status, location_name, member_id, member_full_name,
// position_name, work_type_name, breaks (empty array on every real shift
// seen so far — shape of a populated breaks entry is still unconfirmed, so
// this does NOT subtract break time from hours worked; flag that assumption
// if it ever matters).
export async function fetchRosteredShifts(accessToken, organisationId, fromISO, toISO) {
  const shifts = [];
  let pageIndex = 1;
  let totalPages = 1;
  do {
    const q = new URLSearchParams({
      from_date: fromISO,
      to_date: toISO,
      page_index: String(pageIndex),
    }).toString();
    const res = await fetch(
      `${API_BASE}/api/v1/organisations/${organisationId}/rostered_shifts?${q}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`employment hero rostered shifts fetch failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const page = body?.data || {};
    shifts.push(...(page.items || []));
    totalPages = page.total_pages || 1;
    pageIndex += 1;
  } while (pageIndex <= totalPages);
  return shifts;
}
