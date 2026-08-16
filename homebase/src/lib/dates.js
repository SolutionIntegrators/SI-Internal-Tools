// Date helpers. Every "today" / "this week" question is answered in Ashley's
// timezone (the TIMEZONE var), not in UTC and not in the visitor's locale,
// so the dashboard reads the same from a phone in another state.

export const DAY_MS = 86400000;

/** Y/M/D and weekday for `date` as seen in `tz`. */
export function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: get("weekday"), // Mon, Tue, ...
  };
}

/** "2026-08-16" for `date` in `tz`. */
export function localDate(date, tz) {
  const { year, month, day } = zonedParts(date, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** ISO date of the Monday on or before `date`, in `tz`. */
export function startOfWeek(date, tz) {
  const offset = WEEKDAY_INDEX[zonedParts(date, tz).weekday];
  return addDays(localDate(date, tz), -offset);
}

/** Shift an ISO date string by whole days. Calendar math only, no timezone. */
export function addDays(isoDate, days) {
  const shifted = new Date(`${isoDate}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Inclusive on both ends. All three arguments are ISO date strings. */
export function isBetween(isoDate, startIso, endIso) {
  return isoDate >= startIso && isoDate <= endIso;
}

/** Whole days elapsed since `ms`, rounded down. */
export function daysSince(ms, now) {
  return Math.floor((now - ms) / DAY_MS);
}

/** "Tue 3pm" — the short stamps the dashboard cards use. */
export function shortDateTime(date, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** "3:30pm" for a time on a known day. */
export function shortTime(date, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** "Tue" — used by the week-ahead card. */
export function shortWeekday(date, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
}

/**
 * "today" / "tomorrow" / "Thu" for a due date, relative to now.
 * Anything already past reads as "overdue" so it stands out in the list.
 */
export function relativeDay(date, now, tz) {
  const target = localDate(date, tz);
  const today = localDate(now, tz);
  if (target < today) return "overdue";
  if (target === today) return "today";
  if (target === addDays(today, 1)) return "tomorrow";
  return shortWeekday(date, tz);
}
