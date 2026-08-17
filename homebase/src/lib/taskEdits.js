// Pure helpers behind the two write actions, kept separate so they can be
// tested without touching ClickUp.

import { closedStatuses } from "./filters.js";

/**
 * The status that means "done" for a given list. ClickUp defines statuses per
 * list, so "complete" on one board may be "closed" or "shipped" on another —
 * the type flag is authoritative and the name list is the fallback.
 */
export function pickClosedStatus(statuses, env) {
  const list = statuses || [];
  const byType = list.find((status) => status.type === "closed") || list.find((status) => status.type === "done");
  if (byType) return byType.status;

  const wanted = closedStatuses(env);
  const byName = list.find((status) => wanted.includes(String(status.status).toLowerCase()));
  return byName ? byName.status : null;
}

/**
 * ClickUp wants a due date as epoch milliseconds. Sent with due_date_time
 * false it renders as a plain date, so the exact time only has to be far
 * enough from midnight that no timezone shifts it onto the wrong day —
 * midday UTC holds for every offset from -11 to +11.
 */
export function dueDateToMs(isoDate) {
  if (!isoDate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`Expected a YYYY-MM-DD date, got "${isoDate}"`);
  const ms = Date.parse(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`"${isoDate}" is not a real date`);
  return ms;
}

/** ClickUp task ids are short alphanumerics; reject anything else before building a URL. */
export function validTaskId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id);
}
