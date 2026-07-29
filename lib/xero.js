// xero.js — Xero adapter. Every money figure on the board comes from here.
// See capability-matrix.md (Xero) for the verified-June-2026 specifics this
// file relies on; re-check current docs before changing the auth or report
// shapes below.

const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const PL_URL = "https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss";

// New Xero apps (created on/after 2 Mar 2026) must use granular scopes.
const SCOPES = "offline_access accounting.reports.profitandloss.read";

const WAGE_KEYWORDS =
  /wages|salaries|superannuation|\bsuper\b|payroll|annual leave|long service|workcover/i;

// Directors Fees — carved out of Overheads and tracked on its own per the
// owner's explicit request (25 Jul 2026): it's technically an operating
// expense, but functionally it's the owner's own draw, not a cost of
// running the venue day-to-day. Matches "Directors Fees", "Director's
// Fees", "Directors' Fees". If the owner's chart of accounts ever uses a
// different label for this (e.g. "Directors Remuneration"), this regex
// won't catch it — the dashboard's own reconciliation check (Directors Fees
// shown under the Profit card vs the owner's real P&L line) will surface
// that mismatch, the same way the wage-keyword match gets confirmed during
// reconciliation.
const DIRECTORS_FEES_KEYWORDS = /directors?\s*'?\s*fees?/i;

export function buildAuthorizeUrl(env, redirectUri, state) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.XERO_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

function basicAuthHeader(env) {
  // Xero's token endpoint requires HTTP Basic client auth (client_secret_basic).
  // Sending the secret in the form body fails the exchange after the owner
  // has already clicked Allow — do not "simplify" this.
  return "Basic " + btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
}

export async function exchangeCode(env, code, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(env),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`xero token exchange failed: ${res.status} ${await res.text()}`);
  const tokens = await res.json();
  const tenantId = await pickTenantId(tokens.access_token);
  return { ...tokens, tenantId };
}

export async function refreshTokens(env, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(env),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`xero token refresh failed: ${res.status} ${await res.text()}`);
  // Xero refresh tokens are single-use and rotate on every refresh — the
  // caller MUST persist the new refresh_token, never the old one.
  return res.json();
}

async function pickTenantId(accessToken) {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`xero connections lookup failed: ${res.status}`);
  const conns = await res.json();
  const org = conns.find((c) => c.tenantType === "ORGANISATION") || conns[0];
  if (!org) throw new Error("no Xero organisation connected");
  return { tenantId: org.tenantId, tenantName: org.tenantName };
}

/**
 * Fetch a Profit & Loss for [fromDate, toDate) (YYYY-MM-DD, exclusive end).
 * The `periods`/`timeframe` params are capped at 12 by Xero — split longer
 * ranges into <=12-period calls and the caller stitches them.
 */
export async function fetchProfitAndLoss(accessToken, tenantId, fromDate, toDate) {
  const url = new URL(PL_URL);
  url.searchParams.set("fromDate", fromDate);
  url.searchParams.set("toDate", toDate);
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-Tenant-Id": tenantId,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`xero P&L fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function num(cellValue) {
  const n = Number(String(cellValue).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Walk the P&L Rows per capability-matrix.md's documented shape.
 * Returns { revenue, costOfSales, operatingExpensesTotal, wageLines: [{label, amount}],
 * wagesAndSuper, directorsFeesLines: [{label, amount}], directorsFees, overheads }
 * wageLines is the *proposed* keyword match — the caller must have the owner
 * confirm it during reconciliation before trusting Wage % / Overheads. Same
 * for directorsFeesLines.
 */
export function parseProfitAndLoss(report) {
  const rows = report?.Reports?.[0]?.Rows || [];
  let revenue = null;
  let costOfSales = null;
  let operatingExpensesTotal = null;
  const wageLines = [];
  const directorsFeesLines = [];
  let opExLines = [];

  for (const section of rows) {
    if (section.RowType !== "Section") continue;
    const title = (section.Title || "").toLowerCase();
    const sectionRows = section.Rows || [];
    const summary = sectionRows.find((r) => r.RowType === "SummaryRow");
    const total = summary ? num(summary.Cells[summary.Cells.length - 1].Value) : null;

    if (title.includes("income") && !title.includes("other")) {
      revenue = total;
    } else if (title.includes("cost of sales") || title.includes("cost of goods")) {
      costOfSales = total;
    } else if (title.includes("operating expenses") || title.includes("expenses")) {
      operatingExpensesTotal = total;
      opExLines = sectionRows.filter((r) => r.RowType === "Row");
    }
  }

  for (const row of opExLines) {
    const label = row.Cells?.[0]?.Value || "";
    if (WAGE_KEYWORDS.test(label)) {
      wageLines.push({ label, amount: num(row.Cells[row.Cells.length - 1].Value) });
    } else if (DIRECTORS_FEES_KEYWORDS.test(label)) {
      directorsFeesLines.push({ label, amount: num(row.Cells[row.Cells.length - 1].Value) });
    }
  }

  const wagesAndSuper = wageLines.reduce((sum, l) => sum + l.amount, 0);
  const directorsFees = directorsFeesLines.reduce((sum, l) => sum + l.amount, 0);
  // Overheads now excludes Directors Fees as well as wages/super — it's
  // tracked and shown separately, under the Profit card, rather than buried
  // here. Real bottom-line Profit is unchanged either way (see kpi.js):
  // Directors Fees is just subtracted there directly instead of via
  // Overheads.
  const overheads =
    operatingExpensesTotal === null ? null : operatingExpensesTotal - wagesAndSuper - directorsFees;

  return {
    revenue,
    costOfSales,
    operatingExpensesTotal,
    wageLines,
    wagesAndSuper,
    directorsFeesLines,
    directorsFees,
    overheads,
  };
}