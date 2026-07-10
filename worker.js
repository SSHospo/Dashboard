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
//   INGEST_TOKEN                         — optional, protects the guided-
//                                           upload fallback endpoint

import { hashPassword, verifyPassword, createSessionCookie, verifySessionCookie, CLEAR_SESSION_COOKIE } from "./lib/auth.js";
import { resolvePeriod, previousPeriodOf, sameLastYearOf, toDateInputValue } from "./lib/periods.js";
import { computeMetrics, withComparisons } from "./lib/kpi.js";
import * as xeroAdapter from "./lib/xero.js";
import * as squareAdapter from "./lib/square.js";

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

async function pullXeroForPeriod(env, kv, period, settings) {
  const auth = await getValidXeroAccessToken(env, kv);
  if (!auth) return null;
  const fromDate = toDateInputValue(period.startUTC, settings.timezone);
  // endUTC is exclusive; the P&L's toDate is inclusive, so step back a day.
  const toDate = toDateInputValue(period.endUTC - 24 * 60 * 60 * 1000, settings.timezone);
  const report = await xeroAdapter.fetchProfitAndLoss(auth.accessToken, auth.tenantId, fromDate, toDate);
  return xeroAdapter.parseProfitAndLoss(report);
}

async function pullSquareForPeriod(env, period) {
  if (!env.SQUARE_ACCESS_TOKEN) return null;
  const locationIds = env.SQUARE_LOCATION_IDS
    ? env.SQUARE_LOCATION_IDS.split(",").map((s) => s.trim())
    : (await squareAdapter.listLocations(env.SQUARE_ACCESS_TOKEN)).map((l) => l.id);
  return squareAdapter.countTransactions(
    env.SQUARE_ACCESS_TOKEN,
    locationIds,
    new Date(period.startUTC).toISOString(),
    new Date(period.endUTC).toISOString()
  );
}

async function metricsForPeriod(env, kv, period, settings) {
  const [xero, square] = await Promise.all([
    pullXeroForPeriod(env, kv, period, settings),
    pullSquareForPeriod(env, period),
  ]);
  return computeMetrics(xero, square);
}

/** Split a period into N equal-width buckets and pull metrics for each, for
 * the trend line every metric shows (kpi-spec.md). Approximate (equal-width
 * time slices, not calendar-aware) — good enough for a sparkline. */
async function trendForPeriod(env, kv, period, settings, buckets = 6) {
  const step = Math.floor((period.endUTC - period.startUTC) / buckets);
  const slices = Array.from({ length: buckets }, (_, i) => ({
    startUTC: period.startUTC + i * step,
    endUTC: i === buckets - 1 ? period.endUTC : period.startUTC + (i + 1) * step,
  }));
  const results = await Promise.all(slices.map((s) => metricsForPeriod(env, kv, s, settings)));
  const byMetric = {};
  for (const key of Object.keys(results[0] || {})) {
    byMetric[key] = results.map((r) => (typeof r[key] === "number" ? r[key] : null));
  }
  return byMetric;
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

    const [current, prev, ly, trend] = await Promise.all([
      metricsForPeriod(env, kv, period, settings),
      metricsForPeriod(env, kv, previous, settings),
      metricsForPeriod(env, kv, lastYear, settings),
      trendForPeriod(env, kv, period, settings),
    ]);

    const xeroConnected = !!(await kv.get("xero:tokens"));
    const squareConnected = !!env.SQUARE_ACCESS_TOKEN;

    const metrics = withComparisons(current, prev, ly);
    for (const key of Object.keys(metrics)) {
      metrics[key].trend = trend[key] || [];
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
