// square.js — Square adapter. Supplies exactly one number: the count of
// completed transactions. Never pull a dollar figure from here (kpi-spec.md
// rule 1) — every money figure comes from Xero.

const PRODUCTION_HOST = "https://connect.squareup.com";

/**
 * Count completed orders for [startISO, endISO) across the given location
 * ids. Uses Orders Search, filtered by created_at (not closed_at) and
 * state COMPLETED.
 *
 * Two things learned reconciling against a live venue, in order:
 * 1. The Payments API alone undercounts: this venue takes Uber Eats orders
 *    through Square, and Uber Eats settles payment itself — those orders
 *    never get a Square Payment record, only an Order, so a payments-only
 *    count is structurally blind to them even though Square's own
 *    Transactions report counts them as completed sales.
 * 2. Orders Search filtered by closed_at (the first attempt) overcounted:
 *    an order with a delivery-platform fulfillment attached can sit un-
 *    COMPLETED for a while after the sale actually happened, so closed_at
 *    drifts late and pulls in orders that really belong to an earlier
 *    period. created_at reflects when the order was actually placed and
 *    doesn't have that lag. (Square requires sort.sort_field to match
 *    whichever date_time_filter field is used.)
 */
export async function countTransactions(accessToken, locationIds, startISO, endISO) {
  let count = 0;
  let cursor;
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
            date_time_filter: { created_at: { start_at: startISO, end_at: endISO } },
            state_filter: { states: ["COMPLETED"] },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
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
