// worker.js — the dashboard's Cloudflare Worker. Handles the password gate,
// the Xero/Square connections, and serving computed KPI data to the static
// frontend in public/dashboard.html. Static files are served automatically
// by the ASSETS binding for any request that isn't one of the /api/* routes
// below (see wrangler.toml [assets]).
//
// Secrets this Worker expects in Cloudflare's Settings -> Variables and
// Secrets (never in this repo):
//   XERO_CLIENT_ID, XERO_CLIENT_SECRET   — from the owner's Xero app
//   SQUARE_ACCESS_TOKEN                  — the owner's Square production
//                                           personal access token
//   SQUARE_LOCATION_IDS                  — comma-separated, optional (all
//                                           locations if unset — confirm
//                                           with the owner which to count)
//   EMPLOYMENT_HERO_CLIENT_ID,
//   EMPLOYMENT_HERO_CLIENT_SECRET        — optional, from the owner's
//                                           Employment Hero developer app.
//                                           Only wires the OAuth connection;
//                                           see lib/employmenthero.js — the
//                                           projected Wage % itself isn't
//                                           computed yet (unverified data
//                                           shape, see that file's header).
//   INGEST_TOKEN                         — optional, protects the guided-
//                                           upload fallback endpoint

import { hashPassword, verifyPassword, createSessionCookie, verifySessionCookie, CLEAR_SESSION_COOKIE } from "./lib/auth.js";
import { resolvePeriod, previousPeriodOf, sameLastYearOf, toDateInputValue } from "./lib/periods.js";
import { computeMetrics, withComparisons } from "./lib/kpi.js";
import * as xeroAdapter from "./lib/xero.js";
import * as squareAdapter from "./lib/square.js";
import * as ehAdapter from "./lib/employmenthero.js";

const DEFAULT_SETTINGS = {
  venueName: "",
  timezone: "Australia/Sydney",
  weekStartDay: 1, // Monday
  tradingDayRolloverHour: 4,
  defaultPeriod: "this_week",
  accentColour: "#2a78d6",
  targets: {}, // e.g. { wagePct: 0.30, costOfGoodsPct: 0.30 }
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function getSettings(kv) {
  const raw = await kv.get("settings");
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}

async function requireSession(request, kv) {
  return verifySessionCookie(kv, request.headers.get("Cookie"));
}

async function getValidXeroAccessToken(env, kv) {
  const stored = await kv.get("xero:tokens", "json");
  if (!stored) return null;
  if (stored.accessTokenExpiry > Date.now() + 60_000) {
    return { accessToken: stored.accessToken, tenantId: stored.tenantId };
  }
  const refreshed = await xeroAdapter.refreshTokens(env, stored.refreshToken);
  const updated = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token, // rotates every time — must persist the new one
    accessTokenExpiry: Date.now() + refreshed.expires_in * 1000,
    tenantId: stored.tenantId,
    tenantName: stored.tenantName,
  };
  await kv.put("xero:tokens", JSON.stringify(updated));
  return { accessToken: updated.accessToken, tenantId: updated.tenantId };
}

// CONFIRMED (from a real response, 12 Jul 2026): GET /api/v1/organisations
// returns { data: { items: [{ id, name, phone, country, logo_url }, ...],
// item_per_page, page_index, total_pages, total_items } }. Some items can
// have name: null (other businesses/roles this login can see, not
// necessarily the owner's venue) — pick the one with a real name, since
// that's the one that will actually match the owner's Xero org name.
function pickEmploymentHeroOrg(orgsResponse) {
  const items = orgsResponse?.data?.items || [];
  const named = items.filter((o) => o?.name);
  return named[0] || items[0] || null;
}

// Same shape as getValidXeroAccessToken. Employment Hero access tokens
// expire after 15 minutes (confirmed against their partner-guides docs) —
// refresh well before that with the same 60s safety margin used for Xero.
async function getValidEmploymentHeroAccessToken(env, kv) {
  const stored = await kv.get("eh:tokens", "json");
  if (!stored) return null;
  if (stored.accessTokenExpiry > Date.now() + 60_000) {
    return { accessToken: stored.accessToken, organisationId: stored.organisationId };
  }
  const refreshed = await ehAdapter.refreshTokens(env, stored.refreshToken);
  const updated = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    accessTokenExpiry: Date.now() + refreshed.expires_in * 1000,
    organisationId: stored.organisationId,
    organisationName: stored.organisationName,
  };
  await kv.put("eh:tokens", JSON.stringify(updated));
  return { accessToken: updated.accessToken, organisationId: updated.organisationId };
}

async function pullXeroForPeriod(env, kv, period, settings) {
  const auth = await getValidXeroAccessToken(env, kv);
  if (!auth) return null;
  const fromDate = toDateInputValue(period.startUTC, settings.timezone);
  // endUTC is exclusive; the P&L's toDate is inclusive, so step back a day.
  const toDate = toDateInputValue(period.endUTC - 24 * 60 * 60 * 1000, settings.timezone);
  const report = await xeroAdapter.fetchProfitAndLoss(auth.accessToken, auth.tenantId, fromDate, toDate);
  return xeroAdapter.parseProfitAndLoss(report);
}

/** Resolved once per /api/data request and threaded through every Square
 * call below — re-listing locations per period was burning subrequests for
 * nothing (see the "too many subrequests" incident: fetching the full
 * current period AND 6 trend buckets AND re-listing locations 9 times each
 * pushed a single request past Cloudflare's per-invocation subrequest cap). */
async function resolveSquareLocationIds(env) {
  if (!env.SQUARE_ACCESS_TOKEN) return null;
  if (env.SQUARE_LOCATION_IDS) return env.SQUARE_LOCATION_IDS.split(",").map((s) => s.trim());
  const locs = await squareAdapter.listLocations(env.SQUARE_ACCESS_TOKEN);
  return locs.map((l) => l.id);
}

async function pullSquareForPeriod(env, period, locationIds) {
  if (!env.SQUARE_ACCESS_TOKEN || !locationIds) return null;
  return squareAdapter.countTransactions(
    env.SQUARE_ACCESS_TOKEN,
    locationIds,
    new Date(period.startUTC).toISOString(),
    new Date(period.endUTC).toISOString()
  );
}

/** Raw (unmerged) Xero + Square pulls for one period — kept separate from
 * computeMetrics so callers can sum raw numbers across buckets before
 * deriving percentages (summing percentages directly would be wrong). */
async function rawForPeriod(env, kv, period, settings, locationIds) {
  const [xero, square] = await Promise.all([
    pullXeroForPeriod(env, kv, period, settings),
    pullSquareForPeriod(env, period, locationIds),
  ]);
  return { xero, square };
}

function sumXero(list) {
  const present = list.filter(Boolean);
  if (!present.length) return null;
  const sum = (field) => present.reduce((s, x) => s + (x[field] || 0), 0);
  return {
    revenue: sum("revenue"),
    costOfSales: sum("costOfSales"),
    wagesAndSuper: sum("wagesAndSuper"),
    overheads: sum("overheads"),
  };
}

function sumSquare(list) {
  const present = list.filter((v) => v !== null && v !== undefined);
  if (!present.length) return null;
  return present.reduce((s, v) => s + v, 0);
}

/** Split a period into N equal-width buckets and pull raw data for each —
 * ONE fetch per bucket, reused both to derive the current-period total (by
 * summing) and the trend sparkline (per-bucket), instead of fetching the
 * whole period a second time. Approximate (equal-width time slices, not
 * calendar-aware) — good enough for a sparkline. */
function makeBuckets(period, count) {
  const step = Math.floor((period.endUTC - period.startUTC) / count);
  return Array.from({ length: count }, (_, i) => ({
    startUTC: period.startUTC + i * step,
    endUTC: i === count - 1 ? period.endUTC : period.startUTC + (i + 1) * step,
  }));
}

async function handleApi(request, env, ctx, url) {
  const kv = env.TOKENS;
  const path = url.pathname;

  if (path === "/api/session" && request.method === "GET") {
    const hasPassword = !!(await kv.get("auth:password"));
    const loggedIn = await requireSession(request, kv);
    return json({ hasPassword, loggedIn });
  }

  if (path === "/api/setup-password" && request.method === "POST") {
    const existing = await kv.get("auth:password");
    if (existing) return json({ error: "password already set" }, { status: 409 });
    const { password } = await request.json();
    if (!password || password.length < 8) {
      return json({ error: "password must be at least 8 characters" }, { status: 400 });
    }
    await kv.put("auth:password", await hashPassword(password));
    const cookie = await createSessionCookie(kv);
    return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  }

  if (path === "/api/login" && request.method === "POST") {
    const stored = await kv.get("auth:password");
    if (!stored) return json({ error: "no password set yet" }, { status: 409 });
    const { password } = await request.json();
    const ok = await verifyPassword(password || "", stored);
    if (!ok) return json({ error: "wrong password" }, { status: 401 });
    const cookie = await createSessionCookie(kv);
    return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  }

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, { headers: { "Set-Cookie": CLEAR_SESSION_COOKIE } });
  }

  // Everything below requires a session.
  if (!(await requireSession(request, kv))) {
    return json({ error: "not logged in" }, { status: 401 });
  }

  if (path === "/api/settings" && request.method === "GET") {
    return json(await getSettings(kv));
  }

  if (path === "/api/settings" && request.method === "POST") {
    const body = await request.json();
    const merged = { ...DEFAULT_SETTINGS, ...(await getSettings(kv)), ...body };
    await kv.put("settings", JSON.stringify(merged));
    return json(merged);
  }

  if (path === "/api/connections" && request.method === "GET") {
    const xeroTokens = await kv.get("xero:tokens", "json");
    const ehTokens = await kv.get("eh:tokens", "json");
    const square = env.SQUARE_ACCESS_TOKEN
      ? await squareAdapter
          .listLocations(env.SQUARE_ACCESS_TOKEN)
          .then((locs) => ({ connected: true, locations: locs.map((l) => l.name) }))
          .catch((e) => ({ connected: false, error: String(e) }))
      : { connected: false };
    return json({
      xero: xeroTokens
        ? { connected: true, tenantName: xeroTokens.tenantName }
        : { connected: false },
      square,
      employmentHero: ehTokens
        ? { connected: true, organisationName: ehTokens.organisationName, note: "Connected — projected Wage % isn't wired up yet (see build notes)." }
        : { connected: false },
    });
  }

  if (path === "/api/oauth/xero/start" && request.method === "GET") {
    const redirectUri = `${url.origin}/api/oauth/xero/callback`;
    const state = crypto.randomUUID();
    await kv.put(`xero:oauthstate:${state}`, "1", { expirationTtl: 600 });
    return Response.redirect(xeroAdapter.buildAuthorizeUrl(env, redirectUri, state), 302);
  }

  if (path === "/api/oauth/xero/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const validState = state && (await kv.get(`xero:oauthstate:${state}`));
    if (!code || !validState) return json({ error: "invalid oauth callback" }, { status: 400 });
    await kv.delete(`xero:oauthstate:${state}`);
    const redirectUri = `${url.origin}/api/oauth/xero/callback`;
    const tokens = await xeroAdapter.exchangeCode(env, code, redirectUri);
    await kv.put(
      "xero:tokens",
      JSON.stringify({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiry: Date.now() + tokens.expires_in * 1000,
        tenantId: tokens.tenantId.tenantId,
        tenantName: tokens.tenantId.tenantName,
      })
    );
    return Response.redirect(`${url.origin}/?connected=xero`, 302);
  }

  if (path === "/api/oauth/employmenthero/start" && request.method === "GET") {
    const redirectUri = `${url.origin}/api/oauth/employmenthero/callback`;
    const state = crypto.randomUUID();
    await kv.put(`eh:oauthstate:${state}`, "1", { expirationTtl: 600 });
    return Response.redirect(ehAdapter.buildAuthorizeUrl(env, redirectUri, state), 302);
  }

  if (path === "/api/oauth/employmenthero/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const validState = state && (await kv.get(`eh:oauthstate:${state}`));
    if (!code || !validState) return json({ error: "invalid oauth callback" }, { status: 400 });
    await kv.delete(`eh:oauthstate:${state}`);
    const redirectUri = `${url.origin}/api/oauth/employmenthero/callback`;
    const tokens = await ehAdapter.exchangeCode(env, code, redirectUri);
    // Pick the named organisation, same "confirm it's their business" pattern
    // as Xero's tenant lookup — the owner should verify this on the
    // Connections panel before it's trusted for anything.
    let organisationId = null, organisationName = null;
    try {
      const orgs = await ehAdapter.listOrganisations(tokens.access_token);
      const picked = pickEmploymentHeroOrg(orgs);
      organisationId = picked?.id ?? null;
      organisationName = picked?.name ?? null;
    } catch (e) {
      // Organisation lookup shape is unverified (see lib/employmenthero.js) —
      // don't fail the whole connection over it; the owner can still see
      // "connected" on the Connections panel and we can fix the lookup once
      // we've seen the real response.
      console.error("employment hero organisation lookup failed", e);
    }
    await kv.put(
      "eh:tokens",
      JSON.stringify({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiry: Date.now() + tokens.expires_in * 1000,
        organisationId,
        organisationName,
      })
    );
    return Response.redirect(`${url.origin}/?connected=employmenthero`, 302);
  }

  // TEMPORARY diagnostic route — not part of the finished build. Employment
  // Hero's roster-data response shape isn't publicly documented (see
  // lib/employmenthero.js's header comment), so this exists purely to look
  // at one real response and finish fetchRosterCost() against it. Session-
  // gated like everything else here; safe to leave in briefly, but remove
  // once the real adapter is wired up.
  if (path === "/api/debug/employmenthero" && request.method === "GET") {
    const auth = await getValidEmploymentHeroAccessToken(env, kv);
    if (!auth) return json({ error: "employment hero not connected" }, { status: 400 });

    const results = {};

    results.organisations = await ehAdapter
      .listOrganisations(auth.accessToken)
      .then((data) => ({ ok: true, data }))
      .catch((e) => ({ ok: false, error: String(e) }));

    const orgId =
      auth.organisationId ||
      (results.organisations?.ok ? pickEmploymentHeroOrg(results.organisations.data)?.id : null);
    results.resolvedOrganisationId = orgId || null;

    if (orgId) {
      const end = new Date();
      const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
      const from = start.toISOString().slice(0, 10);
      const to = end.toISOString().slice(0, 10);

      // "from"/"to" returned "Invalid params" — Employment Hero doesn't
      // publicly document this endpoint's query params, so try several
      // plausible names in one pass instead of one guess per round trip.
      const paramSets = {
        from_to: { from, to },
        start_date_end_date: { start_date: from, end_date: to },
        date_from_date_to: { date_from: from, date_to: to },
        from_date_to_date: { from_date: from, to_date: to },
        start_end: { start, end: to },
        startDate_endDate: { startDate: from, endDate: to },
        no_params: null,
      };

      results.rosteredShiftsAttempts = {};
      for (const [label, params] of Object.entries(paramSets)) {
        const base = `https://api.employmenthero.com/api/v1/organisations/${orgId}/rostered_shifts`;
        const testUrl = params ? `${base}?${new URLSearchParams(params).toString()}` : base;
        results.rosteredShiftsAttempts[label] = await fetch(testUrl, {
          headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
        })
          .then(async (res) => {
            const text = await res.text();
            let data;
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
            // Truncate successful bulky responses so the debug page stays
            // readable; failures are usually short already.
            if (res.ok && typeof data === "object") {
              data = JSON.stringify(data).slice(0, 2000);
            }
            return { ok: res.ok, status: res.status, url: testUrl, data };
          })
          .catch((e) => ({ ok: false, error: String(e), url: testUrl }));
      }
    }

    return json(results);
  }

  if (path === "/api/data" && request.method === "GET") {
    const settings = await getSettings(kv);
    const periodKey = url.searchParams.get("period") || settings.defaultPeriod;
    const custom =
      periodKey === "custom"
        ? { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
        : null;

    const period = resolvePeriod(periodKey, settings, Date.now(), custom);
    const previous = previousPeriodOf(period);
    const lastYear = sameLastYearOf(periodKey, settings, Date.now(), custom);
    const locationIds = await resolveSquareLocationIds(env);

    // One fetch per trend bucket, then sum those raw numbers for the current
    // period's totals — NOT a separate full-period fetch on top (that
    // redundant fetch, times 9 periods, is what blew the subrequest limit).
    const buckets = makeBuckets(period, 6);
    const [bucketRaws, prevRaw, lyRaw] = await Promise.all([
      Promise.all(buckets.map((b) => rawForPeriod(env, kv, b, settings, locationIds))),
      rawForPeriod(env, kv, previous, settings, locationIds),
      rawForPeriod(env, kv, lastYear, settings, locationIds),
    ]);

    const current = computeMetrics(
      sumXero(bucketRaws.map((b) => b.xero)),
      sumSquare(bucketRaws.map((b) => b.square))
    );
    const prev = computeMetrics(prevRaw.xero, prevRaw.square);
    const ly = computeMetrics(lyRaw.xero, lyRaw.square);
    const bucketMetrics = bucketRaws.map((b) => computeMetrics(b.xero, b.square));

    const xeroConnected = !!(await kv.get("xero:tokens"));
    const squareConnected = !!env.SQUARE_ACCESS_TOKEN;

    const metrics = withComparisons(current, prev, ly);
    for (const key of Object.keys(metrics)) {
      metrics[key].trend = bucketMetrics.map((m) => (typeof m[key] === "number" ? m[key] : null));
    }

    return json({
      period: { key: periodKey, startUTC: period.startUTC, endUTC: period.endUTC },
      metrics,
      unverified: !(xeroConnected && squareConnected), // reconciliation confirms it via settings, see Milestone 4/5
      sources: { xero: xeroConnected, square: squareConnected },
      lastSynced: new Date().toISOString(),
    });
  }

  if (path === "/api/ingest" && request.method === "POST") {
    // Fallback ladder rung 3/4 — guided upload. Stub: wire per-source parsing
    // when a source actually needs this rung (capability-matrix.md).
    if (env.INGEST_TOKEN) {
      const provided = request.headers.get("X-Ingest-Token");
      if (provided !== env.INGEST_TOKEN) return json({ error: "bad ingest token" }, { status: 401 });
    }
    return json({ error: "not implemented for any source yet" }, { status: 501 });
  }

  return json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (err) {
        console.error(err);
        return json({ error: "server error", detail: String(err && err.message || err) }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  // Rung-2 fallback (scheduled pull) — wire per source and uncomment the
  // matching cron in wrangler.toml when a source needs it.
  async scheduled(event, env, ctx) {
    console.log("scheduled trigger fired with no source wired yet");
  },

  // Rung-1 fallback (inbound email) — complete when a source's own scheduled
  // export is being caught via Cloudflare Email Routing.
  async email(message, env, ctx) {
    console.log("inbound email received with no ingest wired yet");
  },
};
