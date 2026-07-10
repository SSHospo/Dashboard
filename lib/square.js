// square.js — Square adapter. Supplies exactly one number: the count of
// completed transactions. Never pull a dollar figure from here (kpi-spec.md
// rule 1) — every money figure comes from Xero.

const PRODUCTION_HOST = "https://connect.squareup.com";

/**
 * Count completed orders for [startISO, endISO) across the given location
 * ids. Voided/cancelled orders are excluded; refunds are separate records
 * and do not reduce the count. Verify the exact state field names against
 * Square's current docs at build time — this targets the Orders Search API
 * as of June 2026.
 */
export async function countTransactions(accessToken, locationIds, startISO, endISO) {
  let count = 0;
  let cursor = undefined;
  do {
    const res = await fetch(`${PRODUCTION_HOST}/v2/orders/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-06-18",
      },
      body: JSON.stringify({
        location_ids: locationIds,
        cursor,
        query: {
          filter: {
            date_time_filter: {
              closed_at: { start_at: startISO, end_at: endISO },
            },
            state_filter: { states: ["COMPLETED"] },
          },
        },
        limit: 500,
      }),
    });
    if (!res.ok) throw new Error(`square orders search failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    count += (body.orders || []).length;
    cursor = body.cursor;
  } while (cursor);
  return count;
}

export async function listLocations(accessToken) {
  const res = await fetch(`${PRODUCTION_HOST}/v2/locations`, {
    headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": "2026-06-18" },
  });
  if (!res.ok) throw new Error(`square locations failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.locations || [];
}
