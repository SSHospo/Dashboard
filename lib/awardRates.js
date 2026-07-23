// awardRates.js — Restaurant Industry Award [MA000119] pay rates, used only
// to turn rostered HOURS (from Employment Hero) into a *projected* wage
// cost. This never touches real payroll — Xero stays the source of truth
// for the real Wage %. See kpi-spec.md: anything derived this way must
// always be labelled "projected" wherever it's shown.
//
// Rates below are effective 1 July 2026, cross-checked against three
// independent sources (Fair Work's own published pay guide plus two payroll-
// compliance sites) on 23 Jul 2026 — see chat for the verification trail.
// One acknowledged gap: the exact early-morning (midnight-6am) and late-
// night (10pm-midnight) flat-dollar loadings couldn't be pinned down to the
// cent (sources disagreed by a few cents). Low practical impact here since
// the venue trades 7am-2pm, so those windows essentially never apply — left
// unimplemented rather than guessed. If a shift ever genuinely starts before
// 6am or runs past 10pm, this under-counts that shift's cost slightly; flag
// it for the owner rather than silently guessing a number.
//
// THIS TABLE WILL GO STALE. Fair Work updates award rates every 1 July
// (Annual Wage Review) — re-verify before relying on this after mid-2027.

export const AWARD_NAME = "Restaurant Industry Award [MA000119]";
export const RATES_EFFECTIVE = "2026-07-01";

// Adult (21+) full-time/part-time base hourly rates, ordinary hours.
export const LEVELS = [
  { key: "introductory", label: "Introductory", rate: 25.74 },
  { key: "level1", label: "Level 1 (food/bev or kitchen attendant grade 1)", rate: 26.44 },
  { key: "level2", label: "Level 2", rate: 27.08 },
  { key: "level3", label: "Level 3", rate: 27.97 },
  { key: "level4", label: "Level 4 (incl. tradesperson)", rate: 29.45 },
  { key: "level5", label: "Level 5 (supervisor / cook grade 4)", rate: 31.30 },
  { key: "level6", label: "Level 6 (cook grade 5, tradesperson)", rate: 32.13 },
];

const LEVEL_RATE = Object.fromEntries(LEVELS.map((l) => [l.key, l.rate]));

const CASUAL_LOADING = 0.25;

// Junior rates — clause 18.2 of the award, as a fraction of the adult rate.
// 21 and over is full adult rate (not a junior rate).
const JUNIOR_FRACTIONS = [
  { maxAge: 16, fraction: 0.5 }, // 16 and under
  { maxAge: 17, fraction: 0.6 },
  { maxAge: 18, fraction: 0.7 },
  { maxAge: 19, fraction: 0.85 },
  { maxAge: 20, fraction: 1.0 },
];

function juniorFraction(age) {
  if (age === null || age === undefined || age >= 21) return 1;
  const bracket = JUNIOR_FRACTIONS.find((b) => age <= b.maxAge);
  return bracket ? bracket.fraction : 1;
}

// Ordinary-hours penalty multipliers for permanent (full-time/part-time)
// staff. Casuals add the 25% loading on top of whichever applies (confirmed
// pattern across sources: casual Saturday 150%, Sunday 175%, public holiday
// 250% = permanent % + 25 points).
const DAY_MULTIPLIER = {
  weekday: 1.0,
  saturday: 1.25,
  sunday: 1.5,
  publicHoliday: 2.25,
};

/** "weekday" | "saturday" | "sunday" | "publicHoliday", from a local YYYY-MM-DD date string and its weekday index (0=Sun..6=Sat). */
export function classifyDayType(localDateStr, weekdayIndex, publicHolidayDates) {
  if (publicHolidayDates && publicHolidayDates.includes(localDateStr)) return "publicHoliday";
  if (weekdayIndex === 6) return "saturday";
  if (weekdayIndex === 0) return "sunday";
  return "weekday";
}

/**
 * hourlyRateFor({ level, employmentType, age, dayType })
 * level: one of LEVELS[].key
 * employmentType: "casual" | "permanent"
 * age: number | null (null/undefined treated as 21+)
 * dayType: "weekday" | "saturday" | "sunday" | "publicHoliday"
 */
export function hourlyRateFor({ level, employmentType, age, dayType }) {
  const base = LEVEL_RATE[level];
  if (base === undefined) throw new Error(`unknown award level: ${level}`);
  const juniorAdjusted = base * juniorFraction(age);
  const dayMultiplier = DAY_MULTIPLIER[dayType] ?? 1;
  const casualLoading = employmentType === "casual" ? CASUAL_LOADING : 0;
  // Permanent: base * dayMultiplier. Casual: base * (dayMultiplier + 0.25).
  return juniorAdjusted * (dayMultiplier + casualLoading);
}
