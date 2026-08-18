// The filtering rules are the part most likely to drift, so they get tests.
// Run with `npm test`.
import test from "node:test";
import assert from "node:assert/strict";

import {
  selectDueSoon,
  selectReadyForReview,
  selectTickets,
  revenueNote,
  splitCalendar,
  contentStage,
  isClosed,
} from "../src/lib/filters.js";
import { billsDueSoon } from "../src/routes/money.js";
import { projectHealth } from "../src/routes/tasks.js";
import { startOfWeek, endOfWeek, localDate, relativeDay, addDays } from "../src/lib/dates.js";

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

test("bills expand from their recurrence rules and stop at seven days", () => {
  const today = localDate(new Date(NOW), TZ); // Wednesday 2026-08-19
  const records = [
    // Monthly on the 20th — tomorrow.
    { fields: { Name: "James's Car", Amount: 500, Type: "Expense", Book: "Household", Active: true, Frequency: "Monthly", "Day of Month": 20 } },
    // Monthly on the 1st — outside the window.
    { fields: { Name: "Insurance", Amount: 200, Type: "Expense", Book: "Household", Active: true, Frequency: "Monthly", "Day of Month": 1 } },
    // Income, not a bill.
    { fields: { Name: "Retainer", Amount: 750, Type: "Income", Book: "Solution Integrators", Active: true, Frequency: "Monthly", "Day of Month": 21 } },
    // Unchecked Active — Airtable omits the field entirely, which must not read as active.
    { fields: { Name: "Cancelled tool", Amount: 40, Type: "Expense", Book: "Solution Integrators", Frequency: "Monthly", "Day of Month": 21 } },
    // One-time inside the window.
    { fields: { Name: "Capital One", Amount: 2500, Type: "Expense", Book: "Solution Integrators", Active: true, Frequency: "One-time", "Anchor or One-Time Date": addDays(today, 3) } },
  ];
  const bills = billsDueSoon(records, { env: {}, today });
  assert.deepEqual(bills.map((b) => b.name), ["James's Car", "Capital One"]);
  assert.deepEqual(bills.map((b) => b.amount), ["$500", "$2,500"]);
});

test("bills can be limited to one set of books", () => {
  const today = localDate(new Date(NOW), TZ);
  const records = [
    { fields: { Name: "Household bill", Amount: 500, Type: "Expense", Book: "Household", Active: true, Frequency: "Monthly", "Day of Month": 20 } },
    { fields: { Name: "Business bill", Amount: 99, Type: "Expense", Book: "Solution Integrators", Active: true, Frequency: "Monthly", "Day of Month": 20 } },
  ];
  const bills = billsDueSoon(records, { env: { AIRTABLE_BILLS_BOOKS: "Solution Integrators" }, today });
  assert.deepEqual(bills.map((b) => b.name), ["Business bill"]);
});

test("content statuses collapse onto the four stages the card renders", () => {
  assert.equal(contentStage("Idea"), "idea");
  assert.equal(contentStage("To Be Written "), "drafted");
  assert.equal(contentStage("Ready for Krystle"), "drafted");
  assert.equal(contentStage("Ready for Scheduling"), "drafted");
  assert.equal(contentStage("Schedule w/Buffer"), "drafted");
  assert.equal(contentStage("Scheduled"), "scheduled");
  assert.equal(contentStage("Posted"), "posted");
  assert.equal(contentStage("Created from ClickUp"), "idea");
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

test("the week runs Sunday through Saturday, at both ends", () => {
  assert.equal(startOfWeek(new Date("2026-08-19T16:00:00Z"), TZ), "2026-08-16"); // Wed
  assert.equal(startOfWeek(new Date("2026-08-16T16:00:00Z"), TZ), "2026-08-16"); // Sun
  assert.equal(startOfWeek(new Date("2026-08-22T16:00:00Z"), TZ), "2026-08-16"); // Sat
  // The Sunday before rolls back a full week rather than landing on itself.
  assert.equal(startOfWeek(new Date("2026-08-15T16:00:00Z"), TZ), "2026-08-09"); // Sat prior
  assert.equal(endOfWeek(new Date("2026-08-19T16:00:00Z"), TZ), "2026-08-22");
  assert.equal(endOfWeek(new Date("2026-08-16T16:00:00Z"), TZ), "2026-08-22");
});

test("a Sunday week still contains the Monday-dated revenue goal row", () => {
  // Weekly Revenue Goals rows are all Mondays. Matching the week they fall in
  // keeps them found; an exact match on the Sunday start would find nothing
  // and fall back to REVENUE_GOAL every week without saying so.
  const mondays = ["2026-08-17", "2026-08-24", "2026-08-31"];
  for (const monday of mondays) {
    // Any day of that Monday's week must bracket it.
    for (const offset of [0, 1, 5]) {
      const day = new Date(`${addDays(monday, offset)}T16:00:00Z`);
      const start = startOfWeek(day, TZ);
      const end = endOfWeek(day, TZ);
      assert.ok(monday >= start && monday <= end, `${monday} missing from ${start}..${end}`);
    }
  }
});

test("late Saturday night in Chicago is still the same week, not the next one", () => {
  // The rest of this file runs in ET; the business runs on CST, and the whole
  // point of startOfWeek is that the answer follows the configured zone.
  // 04:00Z is Saturday 11pm in Chicago but already Sunday in UTC and in ET.
  const CT = "America/Chicago";
  assert.equal(startOfWeek(new Date("2026-08-23T04:00:00Z"), CT), "2026-08-16");
  assert.equal(startOfWeek(new Date("2026-08-23T04:00:00Z"), TZ), "2026-08-23");
  assert.equal(startOfWeek(new Date("2026-08-23T06:00:00Z"), CT), "2026-08-23");
});

test("due labels read the way a person would say them", () => {
  const now = new Date(NOW);
  assert.equal(relativeDay(new Date(NOW - DAY), now, TZ), "overdue");
  assert.equal(relativeDay(new Date(NOW + 3600000), now, TZ), "today");
  assert.equal(relativeDay(new Date(NOW + DAY), now, TZ), "tomorrow");
  assert.equal(relativeDay(new Date(NOW + 3 * DAY), now, TZ), "Sat");
});

test("project health comes from dates, since Project Status never says 'in trouble'", () => {
  const base = { today: "2026-08-16", ongoingValue: "Ongoing Support" };
  // Implementation was due last month and the build is still in execution.
  assert.equal(
    projectHealth({ ...base, status: "Execution 👩🏾‍🏭", implementation: "2026-07-28", supportEnd: "2026-08-25" }),
    "needs_attention",
  );
  // Implementation still ahead.
  assert.equal(
    projectHealth({ ...base, status: "Invoice Paid 🤑", implementation: "2026-09-14", supportEnd: "2026-12-31" }),
    "on_track",
  );
  // Retainer clients sit past their implementation date by design.
  assert.equal(
    projectHealth({ ...base, status: "Ongoing Support 💁🏾‍♀️", implementation: "2024-10-15", supportEnd: "2026-12-31" }),
    "on_track",
  );
  // Support ended and it isn't a retainer — should have been closed out.
  assert.equal(
    projectHealth({ ...base, status: "Execution 👩🏾‍🏭", implementation: "2026-06-01", supportEnd: "2026-08-03" }),
    "stalled",
  );
  // Missing dates fall back to on_track rather than inventing a problem.
  assert.equal(projectHealth({ ...base, status: "Execution", implementation: "", supportEnd: "" }), "on_track");
});

test("a resolved support ticket counts as closed", () => {
  // Client Support Requests finishes tickets as "resolved", which ClickUp does
  // not type as closed. Left out of CLOSED_STATUSES it made the open-ticket
  // count read ~100 when only 8 were genuinely open.
  const env = { CLOSED_STATUSES: "complete,closed,done,cancelled,canceled,resolved" };
  const ticket = (status, type) => ({ status: { status, type } });

  assert.equal(isClosed(ticket("resolved", "custom"), env), true);
  assert.equal(isClosed(ticket("Resolved", "custom"), env), true, "matching is case-insensitive");
  assert.equal(isClosed(ticket("new", "custom"), env), false);
  assert.equal(isClosed(ticket("request additional info", "custom"), env), false, "still waiting on the client");
});
