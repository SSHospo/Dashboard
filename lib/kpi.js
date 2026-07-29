// kpi.js — the seven locked metrics from kpi-spec.md. This file must not
// redefine any of them; if that ever feels tempting, add a new labelled
// metric instead and leave these alone.

const NOT_CONFIGURED = "not_configured";

function pct(part, whole) {
  if (whole === null || whole === undefined || whole === 0) return null;
  return part / whole;
}

function delta(current, prior) {
  if (current === null || prior === null || prior === undefined) return null;
  if (prior === 0) return null;
  return { abs: current - prior, pct: (current - prior) / Math.abs(prior) };
}

/**
 * xero: { revenue, costOfSales, wagesAndSuper, overheads, directorsFees } | null (null = not connected)
 * squareCount: number | null (null = not connected)
 * Returns the seven metrics for one period. Call again for the previous
 * period and the same period last year to get comparison figures at the
 * call site — this function stays about one period at a time.
 */
export function computeMetrics(xero, squareCount) {
  const revenue = xero ? xero.revenue : null;
  const cogs = xero ? xero.costOfSales : null;
  const wagesAndSuper = xero ? xero.wagesAndSuper : null;
  const overheads = xero ? xero.overheads : null;
  // Directors Fees: carved out of Overheads (25 Jul 2026, owner's request —
  // it's the owner's own draw, not a running cost) and shown under Profit
  // instead. Defaults to 0 (not null) when Xero is connected but no
  // Directors Fees line was found for the period, same as wagesAndSuper.
  const directorsFees = xero ? (xero.directorsFees ?? 0) : null;

  const transactions = squareCount;

  let acs;
  if (revenue === null || transactions === null) {
    acs = NOT_CONFIGURED;
  } else if (transactions === 0) {
    acs = null; // display rule: "—" for divide-by-zero, never an error
  } else {
    acs = revenue / transactions;
  }

  const profitInputsReady =
    revenue !== null &&
    cogs !== null &&
    wagesAndSuper !== null &&
    overheads !== null &&
    directorsFees !== null;
  // Profit still deducts Directors Fees — it's a real expense out of the
  // business either way — just directly here instead of via Overheads.
  // Algebraically identical to the old Profit figure (Overheads dropped by
  // exactly Directors Fees, so it comes straight back out here); this
  // reclassifies where it's shown, not what Profit actually is.
  const profit = profitInputsReady
    ? revenue - cogs - wagesAndSuper - overheads - directorsFees
    : NOT_CONFIGURED;
  // The what-if the owner asked for: profit if Directors Fees hadn't been
  // paid. Always shown alongside the real Profit above it, never in place
  // of it — same "projected/hypothetical figures never replace the actual"
  // rule as the rest of this dashboard.
  const profitBeforeDirectorsFees = profitInputsReady ? profit + directorsFees : NOT_CONFIGURED;

  return {
    revenue: revenue === null ? NOT_CONFIGURED : revenue,
    transactions: transactions === null ? NOT_CONFIGURED : transactions,
    averageCustomerSpend: acs,
    costOfGoods: cogs === null ? NOT_CONFIGURED : cogs,
    costOfGoodsPct: cogs === null ? NOT_CONFIGURED : pct(cogs, revenue),
    wagePct: wagesAndSuper === null ? NOT_CONFIGURED : pct(wagesAndSuper, revenue),
    wagesAndSuper: wagesAndSuper === null ? NOT_CONFIGURED : wagesAndSuper,
    overheads: overheads === null ? NOT_CONFIGURED : overheads,
    directorsFees: directorsFees === null ? NOT_CONFIGURED : directorsFees,
    profit,
    profitPct:
      profit === NOT_CONFIGURED || revenue === null ? NOT_CONFIGURED : pct(profit, revenue),
    profitBeforeDirectorsFees,
    profitBeforeDirectorsFeesPct:
      profitBeforeDirectorsFees === NOT_CONFIGURED || revenue === null
        ? NOT_CONFIGURED
        : pct(profitBeforeDirectorsFees, revenue),
  };
}

/** Attach previous-period and same-period-last-year deltas to a metrics object. */
export function withComparisons(current, previous, lastYear) {
  const out = {};
  for (const key of Object.keys(current)) {
    const cur = current[key];
    out[key] = {
      value: cur,
      vsPrevious: cur === NOT_CONFIGURED ? null : delta(cur, previous?.[key] ?? null),
      vsLastYear: cur === NOT_CONFIGURED ? null : delta(cur, lastYear?.[key] ?? null),
    };
  }
  return out;
}

export function projectedWagePct(rosteredCost, revenue) {
  if (rosteredCost === null || rosteredCost === undefined) return NOT_CONFIGURED;
  return pct(rosteredCost, revenue);
}

export { NOT_CONFIGURED };