// The month grid, as pure calendar math on ISO date strings.
//
// Deliberately timezone-free: a grid cell is a calendar square, not an instant,
// so "which box does 2026-08-20 go in" has the same answer everywhere. The
// timezone question — which local day a Google event or a ClickUp due date
// falls on — is answered before an item reaches this file.

import { addDays } from "./dates.js";

/** Sunday 0 ... Saturday 6, matching the Sunday-start week the rest uses. */
export function weekdayIndex(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/** "2026-08" -> "2026-08-31". */
export function endOfMonth(monthIso) {
  const [year, month] = monthIso.split("-").map(Number);
  // Day 0 of the next month is the last day of this one, and the Date
  // constructor rolls December over to January on its own.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function isValidMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  return !Number.isNaN(Date.parse(`${value}-01T00:00:00Z`));
}

/** Month shifted by whole months, staying a valid "YYYY-MM". */
export function shiftMonth(monthIso, months) {
  const [year, month] = monthIso.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return shifted.toISOString().slice(0, 7);
}

/**
 * The full grid a month is drawn on: whole Sunday-to-Saturday weeks covering
 * every day of the month, so the first and last rows spill into the
 * neighbouring months rather than leaving ragged holes.
 */
export function monthGrid(monthIso) {
  const first = `${monthIso}-01`;
  const last = endOfMonth(monthIso);
  const gridStart = addDays(first, -weekdayIndex(first));
  const gridEnd = addDays(last, 6 - weekdayIndex(last));

  const weeks = [];
  for (let cursor = gridStart; cursor <= gridEnd; cursor = addDays(cursor, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, offset) => addDays(cursor, offset)));
  }

  return { month: monthIso, first, last, gridStart, gridEnd, weeks };
}

/** Group items carrying a `date` into a lookup the grid can index by day. */
export function byDay(items) {
  const days = {};
  for (const item of items) {
    if (!item?.date) continue;
    (days[item.date] ||= []).push(item);
  }
  // Within a day, order by kind so the same types cluster, then by title.
  const rank = { event: 0, milestone: 1, content: 2, payment: 3, bill: 4 };
  for (const date of Object.keys(days)) {
    days[date].sort(
      (a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || String(a.title).localeCompare(String(b.title)),
    );
  }
  return days;
}
