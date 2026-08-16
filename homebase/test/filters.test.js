// The filtering rules are the part most likely to drift, so they get tests.
// Run with `npm test`.
import test from "node:test";
import assert from "node:assert/strict";

import {
  selectDueSoon,
  selectReadyForReview,
  selectTickets,
  selectBillsDueSoon,
  sumCollectedThisWeek,
  revenueNote,
  splitCalendar,
} from "../src/lib/filters.js";
import { toAmount, toText } from "../src/services/airtable.js";
import { startOfWeek, localDate, relativeDay, addDays } from "../src/lib/dates.js";

const TZ = "America/New_York";
const NOW = Date.parse("2026-08-19T16:00:00Z"); // Wednesday, noon ET
const DAY = 86400000;
const env = {};

const task = (overrides) => ({
  name: "Task",
  assignees: [{ id: 1, username: "ashley" }],
  status: { status: "in progress", type: "custom" },
  list: { name: "Comma Mama" },
  ...overrides,
});

test("due soon covers the next three days and keeps overdue work visible", () => {
  const tasks = [
    task({ name: "overdue", due_date: String(NOW - 2 * DAY) }),
    task({ name: "today", due_date: String(NOW + 2 * 3600000) }),
    task({ name: "in three days", due_date: String(NOW + 2.5 * DAY) }),
    task({ name: "next week", due_date: String(NOW + 8 * DAY) }),
    task({ name: "no due date", due_date: null }),
  ];
  const picked = selectDueSoon(tasks, { userId: 1, now: NOW, env }).map((t) => t.name);
  assert.deepEqual(picked, ["overdue", "today", "in three days"]);
});

test("due soon ignores other people's tasks and closed work", () => {
  const tasks = [
    task({ name: "someone else", assignees: [{ id: 9 }], due_date: String(NOW) }),
    task({ name: "already done", status: { status: "complete", type: "closed" }, due_date: String(NOW) }),
    task({ name: "mine", due_date: String(NOW) }),
  ];
  const picked = selectDueSoon(tasks, { userId: 1, now: NOW, env }).map((t) => t.name);
  assert.deepEqual(picked, ["mine"]);
});

test("ready for review ignores the due date entirely", () => {
  const tasks = [
    task({ name: "old review", status: { status: "Ready for Review" }, due_date: String(NOW - 30 * DAY) }),
    task({ name: "future review", status: { status: "In Review" }, due_date: String(NOW + 90 * DAY) }),
    task({ name: "not review", status: { status: "in progress" } }),
  ];
  const picked = selectReadyForReview(tasks, { env }).map((t) => t.name);
  assert.deepEqual(picked, ["old review", "future review"]);
});

test("tickets count everything open but only flag past two days", () => {
  const tickets = [
    task({ name: "fresh", date_created: String(NOW - 4 * 3600000) }),
    task({ name: "two days exactly", date_created: String(NOW - 2 * DAY) }),
    task({ name: "stale", date_created: String(NOW - 5 * DAY) }),
    task({ name: "closed", status: { status: "closed", type: "closed" }, date_created: String(NOW - 9 * DAY) }),
  ];
  const result = selectTickets(tickets, { now: NOW, env });
  assert.equal(result.openCount, 3);
  assert.deepEqual(result.overdue.map((t) => t.name), ["stale"]);
});

test("bills cover the next seven days and nothing outside them", () => {
  const today = localDate(new Date(NOW), TZ);
  const records = [
    { fields: { Due: addDays(today, -1) } },
    { fields: { Due: today } },
    { fields: { Due: addDays(today, 7) } },
    { fields: { Due: addDays(today, 8) } },
    { fields: {} },
  ];
  const picked = selectBillsDueSoon(records, { dueField: "Due", now: NOW, tz: TZ });
  assert.deepEqual(picked.map((p) => p.due), [today, addDays(today, 7)]);
});

test("revenue counts Monday through today, only rows marked paid", () => {
  const weekStart = startOfWeek(new Date(NOW), TZ); // Monday 2026-08-17
  const today = localDate(new Date(NOW), TZ); // Wednesday 2026-08-19
  const records = [
    { fields: { Date: weekStart, Amount: 1500, Status: "Paid" } },
    { fields: { Date: today, Amount: "$2,000", Status: "Received" } },
    { fields: { Date: today, Amount: 900, Status: "Pending" } },
    { fields: { Date: addDays(weekStart, -1), Amount: 5000, Status: "Paid" } },
    { fields: { Date: addDays(today, 2), Amount: 4000, Status: "Paid" } },
  ];
  const total = sumCollectedThisWeek(records, {
    dateField: "Date",
    amountField: "Amount",
    statusField: "Status",
    paidValues: ["Paid", "Received"],
    weekStart,
    today,
    toAmount,
    toText,
  });
  assert.equal(total, 3500);
});

test("the revenue note is arithmetic, not a model call", () => {
  assert.equal(revenueNote(7500, 7500), "Goal hit for the week.");
  assert.equal(revenueNote(7000, 7500), "$500 to go — nearly there.");
  assert.equal(revenueNote(500, 7500), "$7,000 to go, week still young.");
  assert.equal(revenueNote(3000, 7500), "$4,500 to go.");
});

test("calendar splits into next calls, rest of today, and the week ahead", () => {
  const at = (iso) => ({ id: iso, summary: iso, start: { dateTime: iso } });
  const events = [
    { id: "allday", summary: "Vacation", start: { date: "2026-08-19" } },
    at("2026-08-19T14:00:00Z"), // already past
    at("2026-08-19T17:00:00Z"),
    at("2026-08-19T18:00:00Z"),
    at("2026-08-19T21:00:00Z"),
    at("2026-08-21T15:00:00Z"),
  ];
  const { nextCalls, calendarToday, calendarWeek } = splitCalendar(events, { now: NOW, tz: TZ });
  assert.deepEqual(nextCalls.map((e) => e.summary), ["2026-08-19T17:00:00Z", "2026-08-19T18:00:00Z"]);
  assert.deepEqual(calendarToday.map((e) => e.summary), ["2026-08-19T21:00:00Z"]);
  assert.deepEqual(calendarWeek.map((e) => e.summary), ["2026-08-21T15:00:00Z"]);
});

test("week starts on Monday, including when today is Monday or Sunday", () => {
  assert.equal(startOfWeek(new Date("2026-08-19T16:00:00Z"), TZ), "2026-08-17"); // Wed
  assert.equal(startOfWeek(new Date("2026-08-17T16:00:00Z"), TZ), "2026-08-17"); // Mon
  assert.equal(startOfWeek(new Date("2026-08-23T16:00:00Z"), TZ), "2026-08-17"); // Sun
});

test("due labels read the way a person would say them", () => {
  const now = new Date(NOW);
  assert.equal(relativeDay(new Date(NOW - DAY), now, TZ), "overdue");
  assert.equal(relativeDay(new Date(NOW + 3600000), now, TZ), "today");
  assert.equal(relativeDay(new Date(NOW + DAY), now, TZ), "tomorrow");
  assert.equal(relativeDay(new Date(NOW + 3 * DAY), now, TZ), "Sat");
});
