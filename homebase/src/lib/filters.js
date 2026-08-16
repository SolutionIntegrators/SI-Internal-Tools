// The filtering rules the artifact left to the LLM, as plain code. These are
// pure functions over already-fetched records so they can be tested directly
// (test/filters.test.js) and so the answers never drift between reloads.

import { DAY_MS, daysSince, localDate } from "./dates.js";
import { statusName, dueMs, createdMs } from "../services/clickup.js";
import { isAllDay, startsAt } from "../services/google.js";

const DEFAULT_READY_STATUSES = ["ready for review", "in review", "review", "needs review"];
const DEFAULT_CLOSED_STATUSES = ["complete", "closed", "done", "cancelled", "canceled"];

export function readyStatuses(env) {
  return splitList(env.READY_FOR_REVIEW_STATUSES) || DEFAULT_READY_STATUSES;
}

export function closedStatuses(env) {
  return splitList(env.CLOSED_STATUSES) || DEFAULT_CLOSED_STATUSES;
}

function splitList(value) {
  if (!value) return null;
  const items = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : null;
}

export function isClosed(task, env) {
  return task.status?.type === "closed" || closedStatuses(env).includes(statusName(task));
}

/**
 * Tasks assigned to Ashley that are open and due in the next 3 days.
 * Anything already overdue is included and sorted first — an overdue task is
 * more urgent than one due Thursday, and hiding it would be the wrong call.
 */
export function selectDueSoon(tasks, { userId, now, env, limit = 5 }) {
  const horizon = now + 3 * DAY_MS;
  return tasks
    .filter((task) => !isClosed(task, env))
    .filter((task) => (task.assignees || []).some((assignee) => String(assignee.id) === String(userId)))
    .filter((task) => {
      const due = dueMs(task);
      return due !== null && due <= horizon;
    })
    .sort((a, b) => dueMs(a) - dueMs(b))
    .slice(0, limit);
}

/** Anything sitting in a ready-for-review status, due date irrelevant. */
export function selectReadyForReview(tasks, { env, limit = 5 }) {
  const wanted = readyStatuses(env);
  return tasks
    .filter((task) => !isClosed(task, env))
    .filter((task) => wanted.includes(statusName(task)))
    .slice(0, limit);
}

/** Open support tickets, plus the ones that have been open longer than 2 days. */
export function selectTickets(tickets, { now, env, limit = 5 }) {
  const open = tickets.filter((ticket) => !isClosed(ticket, env));
  const overdue = open
    .filter((ticket) => {
      const created = createdMs(ticket);
      return created !== null && daysSince(created, now) > 2;
    })
    .sort((a, b) => createdMs(a) - createdMs(b))
    .slice(0, limit);
  return { openCount: open.length, overdue };
}

/**
 * Split a day's worth of events into the next two calls and the rest of today.
 * All-day items are skipped for "next calls" — they are not meetings.
 */
export function splitCalendar(events, { now, tz, limit = 5 }) {
  const today = localDate(now, tz);
  const upcoming = events
    .filter((event) => !isAllDay(event))
    .filter((event) => startsAt(event).getTime() >= now)
    .sort((a, b) => startsAt(a) - startsAt(b));

  const nextCalls = upcoming.slice(0, 2);
  const nextCallIds = new Set(nextCalls.map((event) => event.id));

  const calendarToday = upcoming
    .filter((event) => localDate(startsAt(event), tz) === today)
    .filter((event) => !nextCallIds.has(event.id))
    .slice(0, limit);

  const calendarWeek = events
    .filter((event) => localDate(startsAt(event), tz) > today)
    .sort((a, b) => startsAt(a) - startsAt(b))
    .slice(0, limit);

  return { nextCalls, calendarToday, calendarWeek };
}

/** The revenue card's one-liner. Plain arithmetic, no model call. */
export function revenueNote(current, goal) {
  if (goal <= 0) return "";
  if (current >= goal) return "Goal hit for the week.";
  const remaining = Math.round(goal - current);
  const share = current / goal;
  if (share >= 0.75) return `$${remaining.toLocaleString("en-US")} to go — nearly there.`;
  if (share <= 0.1) return `$${remaining.toLocaleString("en-US")} to go, week still young.`;
  return `$${remaining.toLocaleString("en-US")} to go.`;
}

/**
 * Map a Social Media Management status onto the four stages the content card
 * renders. The live statuses are Idea, To Be Written, Ready for Krystle,
 * Ready for Scheduling, Schedule w/Buffer, Scheduled, Posted, Archive,
 * Repurpose, and Created from ClickUp.
 */
export function contentStage(status) {
  const text = status.toLowerCase();
  if (text.includes("posted")) return "posted";
  if (text === "scheduled") return "scheduled";
  if (text.includes("schedul") || text.includes("ready") || text.includes("written")) return "drafted";
  return "idea";
}
