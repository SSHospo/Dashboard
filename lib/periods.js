// periods.js — period boundaries in the venue's own timezone, week-start day
// and trading-day rollover. Every metric in kpi-spec.md must use the same
// boundaries for a given period, so this is the one place that computes them.
//
// A "period" here is { startUTC, endUTC } — endUTC is exclusive.

const MS_MIN = 60 * 1000;

/**
 * Find the UTC instant that corresponds to a given local wall-clock time in
 * `timeZone`. Uses the standard "guess, measure offset, adjust" trick, which
 * is correct except in the ~1hr DST-transition window twice a year — good
 * enough for a business dashboard; revisit if reconciliation ever lands on a
 * DST-change day.
 */
function zonedTimeToUtc(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset = tzOffsetMinutes(guess, timeZone);
  return guess - offset * MS_MIN;
}

function tzOffsetMinutes(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUTC - utcMs) / MS_MIN);
}

function localParts(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value])
  );
  const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[
    parts.weekday
  ];
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    weekday: weekdayIndex,
  };
}

/** The "trading day" a given UTC instant belongs to, honouring rollover. */
function tradingDayLocalDate(utcMs, timeZone, rolloverHour) {
  const p = localParts(utcMs, timeZone);
  if (p.h < rolloverHour) {
    // Belongs to the previous trading day — step back 24h and re-read.
    return localParts(utcMs - 24 * 60 * MS_MIN, timeZone);
  }
  return p;
}

function addDays(y, mo, d, n) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function startOfWeek({ y, mo, d, weekday }, weekStartDay) {
  const diff = (weekday - weekStartDay + 7) % 7;
  return addDays(y, mo, d, -diff);
}

function financialYearStart(y, mo) {
  // AU financial year: 1 July to 30 June.
  return mo >= 7 ? { y, mo: 7, d: 1 } : { y: y - 1, mo: 7, d: 1 };
}

/**
 * settings: { timezone, weekStartDay (0=Sun..6=Sat), tradingDayRolloverHour }
 * Returns { startUTC, endUTC } as epoch ms, endUTC exclusive, for the given
 * trading-day boundary (start of day includes the rollover hour).
 */
function dayBoundsUTC({ y, mo, d }, settings) {
  const start = zonedTimeToUtc(y, mo, d, settings.tradingDayRolloverHour, 0, settings.timezone);
  const next = addDays(y, mo, d, 1);
  const end = zonedTimeToUtc(next.y, next.mo, next.d, settings.tradingDayRolloverHour, 0, settings.timezone);
  return { startUTC: start, endUTC: end };
}

export function resolvePeriod(periodKey, settings, nowUTC = Date.now(), custom = null) {
  const today = tradingDayLocalDate(nowUTC, settings.timezone, settings.tradingDayRolloverHour);

  switch (periodKey) {
    case "this_week": {
      const s = startOfWeek(today, settings.weekStartDay);
      return spanDays(s, 7, settings);
    }
    case "last_week": {
      const s = addDays(...spanArgs(startOfWeek(today, settings.weekStartDay)), -7);
      return spanDays(s, 7, settings);
    }
    case "this_month": {
      const s = { y: today.y, mo: today.mo, d: 1 };
      const nextMonth = today.mo === 12 ? { y: today.y + 1, mo: 1, d: 1 } : { y: today.y, mo: today.mo + 1, d: 1 };
      return { startUTC: dayBoundsUTC(s, settings).startUTC, endUTC: dayBoundsUTC(nextMonth, settings).startUTC };
    }
    case "last_month": {
      const s = today.mo === 1 ? { y: today.y - 1, mo: 12, d: 1 } : { y: today.y, mo: today.mo - 1, d: 1 };
      const e = { y: today.y, mo: today.mo, d: 1 };
      return { startUTC: dayBoundsUTC(s, settings).startUTC, endUTC: dayBoundsUTC(e, settings).startUTC };
    }
    case "this_fy": {
      const s = financialYearStart(today.y, today.mo);
      const e = { y: s.y + 1, mo: 7, d: 1 };
      return { startUTC: dayBoundsUTC(s, settings).startUTC, endUTC: dayBoundsUTC(e, settings).startUTC };
    }
    case "last_fy": {
      const s = financialYearStart(today.y, today.mo);
      const prevS = { y: s.y - 1, mo: 7, d: 1 };
      return { startUTC: dayBoundsUTC(prevS, settings).startUTC, endUTC: dayBoundsUTC(s, settings).startUTC };
    }
    case "custom": {
      if (!custom || !custom.start || !custom.end) throw new Error("custom period needs start and end");
      const [sy, smo, sd] = custom.start.split("-").map(Number);
      const [ey, emo, ed] = custom.end.split("-").map(Number);
      const endExclusive = addDays(ey, emo, ed, 1);
      return { startUTC: dayBoundsUTC({ y: sy, mo: smo, d: sd }, settings).startUTC, endUTC: dayBoundsUTC(endExclusive, settings).startUTC };
    }
    default:
      throw new Error(`unknown period: ${periodKey}`);
  }
}

function spanArgs(o) {
  return [o.y, o.mo, o.d];
}

function spanDays(start, nDays, settings) {
  const end = addDays(start.y, start.mo, start.d, nDays);
  return { startUTC: dayBoundsUTC(start, settings).startUTC, endUTC: dayBoundsUTC(end, settings).startUTC };
}

/** The immediately-preceding period of equal length, for comparison. */
export function previousPeriodOf(period) {
  const len = period.endUTC - period.startUTC;
  return { startUTC: period.startUTC - len, endUTC: period.startUTC };
}

/** The same period one year earlier (calendar year shift, not a fixed ms offset). */
export function sameLastYearOf(periodKey, settings, nowUTC, custom) {
  if (periodKey === "custom" && custom) {
    const [sy, smo, sd] = custom.start.split("-").map(Number);
    const [ey, emo, ed] = custom.end.split("-").map(Number);
    return resolvePeriod("custom", settings, nowUTC, {
      start: `${sy - 1}-${String(smo).padStart(2, "0")}-${String(sd).padStart(2, "0")}`,
      end: `${ey - 1}-${String(emo).padStart(2, "0")}-${String(ed).padStart(2, "0")}`,
    });
  }
  // Shift "now" back exactly one year and recompute the same named period —
  // correct for month/FY-anchored periods; week-anchored periods drift by
  // weekday alignment, which is expected (weeks don't repeat on a 365-day cycle).
  const shifted = new Date(nowUTC);
  shifted.setUTCFullYear(shifted.getUTCFullYear() - 1);
  return resolvePeriod(periodKey, settings, shifted.getTime(), custom);
}

export function toDateInputValue(utcMs, timeZone) {
  const p = localParts(utcMs, timeZone);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
