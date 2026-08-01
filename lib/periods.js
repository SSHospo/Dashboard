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

// BUG FOUND 25 Jul 2026, confirmed against a raw response from the owner's
// real Employment Hero account: rostered_shifts' start_time/end_time come
// back with a "Z" (UTC) suffix, e.g. "2026-07-19T10:00:00.000Z" — but the
// clock digits in that string are already the venue's LOCAL (Sydney) wall-
// clock time, not a true UTC instant. Employment Hero mislabels it. Treating
// it as real UTC (plain Date.parse, what this code did before the fix) and
// then converting to local time added the Sydney offset a SECOND time,
// pushing every roster shift about 10-11 hours later than it actually
// happened — a 6am-3pm shift showed up costed against 5pm-11pm. This
// function undoes that: it reads the literal digits Employment Hero sent
// (via the UTC getters, which return exactly what's written regardless of
// this runtime's own timezone) and re-interprets them as local time in
// `timeZone`, the correct way, using the same zonedTimeToUtc conversion
// used everywhere else in this file. ONLY use this for Employment Hero
// shift timestamps — every other UTC timestamp in this app (Xero, Square,
// this app's own period boundaries) is genuinely UTC and must NOT go
// through this correction.
export function employmentHeroShiftTimeToUtcMs(isoString, timeZone) {
  if (!isoString) return NaN;
  const raw = new Date(isoString);
  if (Number.isNaN(raw.getTime())) return NaN;
  return zonedTimeToUtc(
    raw.getUTCFullYear(),
    raw.getUTCMonth() + 1,
    raw.getUTCDate(),
    raw.getUTCHours(),
    raw.getUTCMinutes(),
    timeZone
  );
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

/** The immediately-FOLLOWING period of equal length — the mirror of
 * previousPeriodOf. Used by the Wage forecast (worker.js): the owner wants
 * a rostering budget for the week AHEAD, not the week currently on screen,
 * so the forecast is computed for nextPeriodOf(selected period), not the
 * selected period itself. */
export function nextPeriodOf(period) {
  const len = period.endUTC - period.startUTC;
  return { startUTC: period.endUTC, endUTC: period.endUTC + len };
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

/** Shift a UTC instant by `days` calendar days in `timeZone`, keeping the
 * same local hour/minute — used by fiftyTwoWeeksPriorOf below. Calendar-date
 * arithmetic (addDays) plus a fresh zonedTimeToUtc conversion for the new
 * date, so this is correct across DST changes (unlike a raw ms subtraction,
 * which would silently shift the local wall-clock time by an hour if a DST
 * boundary falls between the two dates). */
function shiftUtcByCalendarDays(utcMs, days, timeZone) {
  const p = localParts(utcMs, timeZone);
  const shifted = addDays(p.y, p.mo, p.d, days);
  return zonedTimeToUtc(shifted.y, shifted.mo, shifted.d, p.h, p.mi, timeZone);
}

/**
 * The same date range, exactly 52 weeks (364 days) earlier — NOT a calendar-
 * year shift. Deliberately different from sameLastYearOf() above: that
 * function shifts the calendar year (e.g. 3 Aug 2026 -> 3 Aug 2025), which
 * for a week-anchored period lands on a different weekday (365/366 isn't
 * divisible by 7) — documented there as an accepted tradeoff for the
 * standard "vs same period last year" comparison shown on every card. 364
 * days IS divisible by 7, so this always preserves weekday alignment: a
 * Monday-Sunday week compares to the Monday-Sunday week 52 weeks earlier,
 * every time. That matters here specifically because trade (and therefore
 * the wages a venue can afford) is driven by day-of-week — comparing a
 * Fri-Sat-heavy week to a range that happens to land on quieter weekdays
 * would understate the real revenue base. Used ONLY for the Wage forecast
 * feature (worker.js) — every other "vs last year" comparison on the board
 * still uses sameLastYearOf() on purpose; do not swap those over to this
 * without the owner asking for that too, since it would change every
 * existing comparison's basis, not just this one new figure.
 */
export function fiftyTwoWeeksPriorOf(period, settings) {
  const WEEKS = 52;
  const days = -(WEEKS * 7);
  return {
    startUTC: shiftUtcByCalendarDays(period.startUTC, days, settings.timezone),
    endUTC: shiftUtcByCalendarDays(period.endUTC, days, settings.timezone),
  };
}

export function toDateInputValue(utcMs, timeZone) {
  const p = localParts(utcMs, timeZone);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Local calendar date (YYYY-MM-DD), weekday index (0=Sun..6=Sat) and local
 * hour (0-23) for a UTC instant — used by the award-rate projection to tell
 * which day-of-week penalty rate applies to a given shift, and by the
 * hour-by-hour Sales x Labour breakdown to bucket a single instant (e.g. an
 * order's created_at) into its local hour-of-day slot. Not trading-day-
 * rollover-aware (that's deliberate — award rates and "what hour did this
 * sale happen in" both key off the actual local clock, not the venue's
 * trading-day boundary). */
export function localDateAndWeekday(utcMs, timeZone) {
  const p = localParts(utcMs, timeZone);
  return {
    dateStr: `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`,
    weekday: p.weekday,
    hour: p.h,
  };
}

/**
 * Split a UTC time range into segments, each entirely within one local
 * hour-of-day bucket (and one local calendar date). Used to attribute a
 * roster shift that spans multiple hours — or crosses midnight — to each
 * hour slot it actually covers, for the hour-by-hour Sales x Labour
 * breakdown. Same "good enough for a business dashboard, not DST-transition-
 * safe" approximation as zonedTimeToUtc above: assumes local time advances
 * linearly with UTC time within a shift, which is wrong only in the ~1hr
 * twice-a-year DST-change window.
 */
export function splitRangeByLocalHour(startMs, endMs, timeZone) {
  const segments = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const p = localParts(cursor, timeZone);
    const dateStr = `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    const msToHourBoundary = (60 - p.mi) * MS_MIN;
    const segmentEnd = Math.min(cursor + msToHourBoundary, endMs);
    segments.push({
      dateStr,
      weekday: p.weekday,
      hour: p.h,
      durationHours: (segmentEnd - cursor) / (60 * MS_MIN),
    });
    cursor = segmentEnd;
  }
  return segments;
}
