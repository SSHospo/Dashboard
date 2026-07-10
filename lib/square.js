// square.js — Square adapter. Supplies exactly one number: the count of
// completed transactions. Never pull a dollar figure from here (kpi-spec.md
// rule 1) — every money figure comes from Xero.

const PRODUCTION_HOST = "https://connect.squareup.com";

/**
 * Count completed payments for [startISO, endISO) across the given location
 * ids. Deliberately uses the Payments API (not Orders Search): reconciliation
 * against a live venue found the Orders API overcounts against what Square's
 * own dashboard reports (an order can sit COMPLETED without every payment on
 * it landing in the same window, and non-payment order records get swept in
 * too) — Square's own Sales/Transactions reporting is payment-based, so this
 * matches it instead of the order lifecycle. Only status === "COMPLETED" is
 * counted; refunds are separate records and never reduce the count.
 */
export async function countTransactions(accessToken, locationIds, startISO, endISO) {
  let count = 0;
  for (const locationId of locationIds) {
    let cursor;
    do {
      const url = new URL(`${PRODUCTION_HOST}/v2/payments`);
      url.searchParams.set("location_id", locationId);
      url.searchParams.set("begin_time", startISO);
      url.searchParams.set("end_time", endISO);
      url.searchParams.set("sort_order", "ASC");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": "2026-06-18" },
      });
      if (!res.ok) throw new Error(`square list payments failed: ${res.status} ${await res.text()}`);
      const body = await res.json();
      count += (body.payments || []).filter((p) => p.status === "COMPLETED").length;
      cursor = body.cursor;
    } while (cursor);
  }
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
