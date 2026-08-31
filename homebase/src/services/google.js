// Google Calendar. Google has no simple API key for a personal calendar, so
// this uses the one-time refresh token minted by scripts/google-oauth.mjs and
// exchanges it for a short-lived access token on demand.
import { fetchJson, requireVar, UpstreamError } from "../lib/http.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

// Access tokens last an hour; a Worker isolate lives well under that, so
// caching in module scope saves a token exchange on most requests.
let cachedToken = null;

async function accessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;

  const body = new URLSearchParams({
    client_id: requireVar(env, "GOOGLE_CLIENT_ID"),
    client_secret: requireVar(env, "GOOGLE_CLIENT_SECRET"),
    refresh_token: requireVar(env, "GOOGLE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });
  const data = await fetchJson("Google Calendar", TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!data.access_token) throw new UpstreamError("Google Calendar", "no access token returned");
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return cachedToken.value;
}

/** Events between two instants, expanded from recurrence and time-ordered. */
export async function listEvents(env, { timeMin, timeMax, maxResults = 50, query }) {
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxResults),
  });
  if (query) params.set("q", query);

  const token = await accessToken(env);
  const data = await fetchJson(
    "Google Calendar",
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.items || [];
}

/** All-day events have a `date`; timed events have a `dateTime`. */
export function isAllDay(event) {
  return Boolean(event.start?.date);
}

export function startsAt(event) {
  return new Date(event.start?.dateTime || `${event.start?.date}T00:00:00Z`);
}

export function summarize(event) {
  return {
    title: event.summary || "(no title)",
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    allDay: isAllDay(event),
    location: event.location || null,
    attendees: (event.attendees || []).map((a) => a.email).slice(0, 10),
  };
}
