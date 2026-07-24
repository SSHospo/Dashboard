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

// --- Sales-by-category (optional extra — kpi-spec.md's "Optional extras"
// section explicitly allows this, PROVIDED it's never presented as the
// locked Revenue metric. gross_sales_money is Square's own pre-discount
// line-item total; in Australia GST is priced inclusively so this figure
// INCLUDES GST, unlike every dollar figure computed from Xero elsewhere in
// this app (kpi-spec.md rule 1). Keep that distinction visible wherever
// this is displayed — label it "Square sales", never "Revenue". ---

/**
 * Catalog category names, plus a lookup from ITEM_VARIATION id (what an
 * order line item's catalog_object_id actually references — CONFIRMED
 * against Square's current API reference, 24 Jul 2026) to the owning
 * item's category name. An item can carry more than one category in
 * Square's current catalog model (item_data.categories[], plural) — this
 * takes the first one; a multi-category item's sales all land under that
 * first category rather than being split.
 */
export async function fetchCatalogCategoryMap(accessToken) {
  const categoryNameById = new Map();
  const rawItems = [];
  let cursor;
  do {
    const url = new URL(`${PRODUCTION_HOST}/v2/catalog/list`);
    url.searchParams.set("types", "ITEM,CATEGORY");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": "2026-06-18" },
    });
    if (!res.ok) throw new Error(`square catalog list failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    for (const obj of body.objects || []) {
      if (obj.type === "CATEGORY") categoryNameById.set(obj.id, obj.category_data?.name || "Uncategorised");
      else if (obj.type === "ITEM") rawItems.push(obj);
    }
    cursor = body.cursor;
  } while (cursor);

  const categoryNameByVariationId = new Map();
  for (const item of rawItems) {
    const categoryId = item.item_data?.categories?.[0]?.id;
    const categoryName = categoryId ? categoryNameById.get(categoryId) || "Uncategorised" : "Uncategorised";
    for (const variation of item.item_data?.variations || []) {
      categoryNameByVariationId.set(variation.id, categoryName);
    }
  }

  return { categoryNames: [...new Set(categoryNameById.values())], categoryNameByVariationId };
}

/**
 * Cents of gross line-item sales per category for [startISO, endISO).
 * Same Orders Search filter (created_at, COMPLETED) as countTransactions,
 * kept as a separate function rather than sharing code with it — that
 * function is already reconciled against the owner's real Square reports
 * and shouldn't be touched for an unrelated optional extra.
 */
export async function fetchLineItemSalesByCategory(accessToken, locationIds, startISO, endISO, categoryNameByVariationId) {
  const centsByCategory = new Map();
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
    for (const order of body.orders || []) {
      for (const li of order.line_items || []) {
        const categoryName = categoryNameByVariationId.get(li.catalog_object_id) || "Uncategorised";
        const cents = Number(li.gross_sales_money?.amount || 0);
        centsByCategory.set(categoryName, (centsByCategory.get(categoryName) || 0) + cents);
      }
    }
    cursor = body.cursor;
  } while (cursor);
  return centsByCategory;
}
