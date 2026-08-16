// Bills in the 99 Problems base are recurrence rules, not dated rows: a record
// says "monthly on the 20th" or "every 2 weeks from this anchor". To answer
// "what's due in the next 7 days" we have to expand those rules over the
// window ourselves.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toUtc(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDays(isoDate, days) {
  const date = toUtc(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * A bill set for the 31st still comes due in a 30-day month. Clamping to the
 * last day is what a person means by "the 31st", and it keeps a monthly bill
 * from silently vanishing in February.
 */
function monthlyDate(year, monthIndex, dayOfMonth) {
  const day = Math.min(dayOfMonth, daysInMonth(year, monthIndex));
  return toIso(new Date(Date.UTC(year, monthIndex, day)));
}

/**
 * Every date in [startIso, endIso] on which `item` comes due.
 *
 * item: { frequency, dayOfMonth, weekday, anchorDate }
 * frequency is one of Monthly, Weekly, Every 2 Weeks, Quarterly, One-time.
 */
export function occurrencesInWindow(item, startIso, endIso) {
  if (startIso > endIso) return [];
  const { frequency, dayOfMonth, weekday, anchorDate } = item;

  switch (frequency) {
    case "One-time":
      return anchorDate && anchorDate >= startIso && anchorDate <= endIso ? [anchorDate] : [];

    case "Weekly": {
      const target = WEEKDAYS.indexOf(weekday);
      if (target < 0) return [];
      const dates = [];
      for (let cursor = startIso; cursor <= endIso; cursor = shiftDays(cursor, 1)) {
        if (toUtc(cursor).getUTCDay() === target) dates.push(cursor);
      }
      return dates;
    }

    case "Every 2 Weeks": {
      if (!anchorDate) return [];
      // The anchor is the first occurrence, so a rule that starts after the
      // window has nothing due in it yet.
      if (anchorDate > endIso) return [];
      // Walk the 14-day cadence from the anchor, in whichever direction the
      // window lies, so a rule anchored years ago still lands correctly.
      const step = 14;
      const dayGap = Math.round((toUtc(startIso) - toUtc(anchorDate)) / 86400000);
      const periods = Math.floor(dayGap / step);
      let cursor = shiftDays(anchorDate, periods * step);
      while (cursor < startIso) cursor = shiftDays(cursor, step);
      const dates = [];
      while (cursor <= endIso) {
        dates.push(cursor);
        cursor = shiftDays(cursor, step);
      }
      return dates;
    }

    case "Monthly":
    case "Quarterly": {
      const stride = frequency === "Quarterly" ? 3 : 1;
      // A quarterly rule takes its phase from the anchor, and like the
      // biweekly case it doesn't run before that anchor.
      if (stride > 1 && anchorDate && anchorDate > endIso) return [];
      // Quarterly rules take their month from the anchor; monthly ones land in
      // every month. Both take their day from Day of Month, falling back to
      // the anchor's day.
      const day = dayOfMonth || (anchorDate ? toUtc(anchorDate).getUTCDate() : 0);
      if (!day) return [];

      const start = toUtc(startIso);
      const end = toUtc(endIso);
      const dates = [];
      // Start a month early so a clamped date at the end of the previous month
      // is still considered.
      for (
        let probe = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
        probe <= end;
        probe.setUTCMonth(probe.getUTCMonth() + 1)
      ) {
        if (stride > 1) {
          if (!anchorDate) return [];
          const anchor = toUtc(anchorDate);
          const monthsApart =
            (probe.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
            (probe.getUTCMonth() - anchor.getUTCMonth());
          if (monthsApart % stride !== 0) continue;
        }
        const due = monthlyDate(probe.getUTCFullYear(), probe.getUTCMonth(), day);
        if (due >= startIso && due <= endIso) dates.push(due);
      }
      return dates;
    }

    default:
      return [];
  }
}
