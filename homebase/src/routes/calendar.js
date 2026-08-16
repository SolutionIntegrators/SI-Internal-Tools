// GET /api/dashboard/calendar — Google Calendar.
import { json } from "../lib/http.js";
import { localDate, addDays, shortTime, shortWeekday } from "../lib/dates.js";
import * as google from "../services/google.js";
import { splitCalendar } from "../lib/filters.js";
import { readSnapshot, writeSnapshot } from "../lib/cache.js";

export async function handleCalendar(env, ctx) {
  const tz = env.TIMEZONE;
  const now = Date.now();

  // From this moment through the end of the seventh day out, so "this week"
  // always has something in it even late on a Friday.
  const timeMin = new Date(now);
  const timeMax = new Date(`${addDays(localDate(new Date(now), tz), 8)}T00:00:00Z`);

  const events = await google.listEvents(env, { timeMin, timeMax, maxResults: 100 });
  const { nextCalls, calendarToday, calendarWeek } = splitCalendar(events, { now, tz });

  const payload = {
    nextCalls: nextCalls.map((event) => ({
      time: shortTime(google.startsAt(event), tz),
      title: event.summary || "(no title)",
    })),
    calendarToday: calendarToday.map((event) => ({
      time: shortTime(google.startsAt(event), tz),
      title: event.summary || "(no title)",
    })),
    calendarWeek: calendarWeek.map((event) => ({
      day: shortWeekday(google.startsAt(event), tz),
      title: event.summary || "(no title)",
    })),
    warnings: [],
  };

  ctx.waitUntil(writeSnapshot(env, "calendar", payload));
  return json(payload);
}

export async function cachedCalendar(env) {
  return readSnapshot(env, "calendar");
}
