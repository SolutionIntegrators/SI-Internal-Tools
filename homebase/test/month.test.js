// The month grid and the endpoint that fills it.
import test from "node:test";
import assert from "node:assert/strict";

import { monthGrid, endOfMonth, weekdayIndex, shiftMonth, isValidMonth, byDay } from "../src/lib/month.js";
import { handleMonth } from "../src/routes/month.js";
import { handleCreateTask } from "../src/routes/taskCreate.js";

const env = {
  TIMEZONE: "America/Chicago",
  CLICKUP_CONTENT_LIST_ID: "901414048215",
  AIRTABLE_MONEY_BASE_ID: "appfVpfMqptf35xRa",
  AIRTABLE_PROJECTS_TABLE: "ALL Active Projects",
  AIRTABLE_INVOICE_TABLE: "Invoice Tracking",
  AIRTABLE_BILLS_BASE_ID: "appQeUH0Lb6i3lxTL",
  AIRTABLE_BILLS_TABLE: "Recurring Items",
};
const ctx = { waitUntil() {} };
const post = (body) => new Request("https://x/", { method: "POST", body: JSON.stringify(body) });
const monthUrl = (month) => new URL(`https://x/api/dashboard/month${month ? `?month=${month}` : ""}`);

test("a grid covers whole Sunday-to-Saturday weeks around the month", () => {
  // August 2026: the 1st is a Saturday, the 31st a Monday. So the grid has to
  // reach back to Jul 26 and forward to Sep 5 to keep every row complete.
  const grid = monthGrid("2026-08");
  assert.equal(grid.first, "2026-08-01");
  assert.equal(grid.last, "2026-08-31");
  assert.equal(grid.gridStart, "2026-07-26");
  assert.equal(grid.gridEnd, "2026-09-05");
  assert.equal(weekdayIndex(grid.gridStart), 0, "grid starts on a Sunday");
  assert.equal(weekdayIndex(grid.gridEnd), 6, "grid ends on a Saturday");
  for (const week of grid.weeks) assert.equal(week.length, 7);
  assert.ok(grid.weeks.flat().includes("2026-08-01"));
  assert.ok(grid.weeks.flat().includes("2026-08-31"));
});

test("month ends are right across leap years and December", () => {
  assert.equal(endOfMonth("2026-02"), "2026-02-28");
  assert.equal(endOfMonth("2024-02"), "2024-02-29"); // leap
  assert.equal(endOfMonth("2026-12"), "2026-12-31");
  assert.equal(endOfMonth("2026-04"), "2026-04-30");
  // December must roll into the next year rather than overflow.
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(monthGrid("2026-12").last, "2026-12-31");
});

test("a junk month parameter is ignored rather than trusted", () => {
  for (const bad of ["2026-13", "2026-00", "not-a-month", "2026-8", "", null, "2026-08-01"]) {
    assert.equal(isValidMonth(bad), false, `${bad} should be rejected`);
  }
  assert.equal(isValidMonth("2026-08"), true);
});

test("items land on their day, ordered so kinds cluster", () => {
  const days = byDay([
    { kind: "bill", date: "2026-08-20", title: "Adobe" },
    { kind: "event", date: "2026-08-20", title: "Kickoff call" },
    { kind: "content", date: "2026-08-20", title: "Reel" },
    { kind: "content", date: "2026-08-21", title: "Carousel" },
    { date: null, title: "undated" },
    { kind: "content", title: "no date key" },
  ]);
  assert.deepEqual(days["2026-08-20"].map((i) => i.kind), ["event", "content", "bill"]);
  assert.deepEqual(Object.keys(days).sort(), ["2026-08-20", "2026-08-21"]);
});

test("the endpoint returns a full grid even with every source unconfigured", async () => {
  const response = await handleMonth(env, ctx, monthUrl("2026-08"));
  assert.equal(response.status, 200, "should degrade, not fail");
  const body = await response.json();
  assert.equal(body.month, "2026-08");
  assert.equal(body.gridStart, "2026-07-26");
  assert.deepEqual(body.days, {});
  assert.deepEqual(body.unscheduled, []);
  assert.ok(body.contentTypes.includes("Reel"));
  assert.ok(body.warnings.length, "dead sources should be named");
});

test("an out-of-range month falls back to the current one instead of erroring", async () => {
  const body = await (await handleMonth(env, ctx, monthUrl("2026-99"))).json();
  assert.ok(isValidMonth(body.month));
  const noParam = await (await handleMonth(env, ctx, monthUrl())).json();
  assert.ok(isValidMonth(noParam.month));
});

test("creating a task validates the body before calling ClickUp", async () => {
  const noTitle = await handleCreateTask(post({ due: "2026-08-21" }), env);
  assert.equal(noTitle.status, 400);
  assert.match((await noTitle.json()).error, /title is required/i);

  const blank = await handleCreateTask(post({ title: "   " }), env);
  assert.equal(blank.status, 400);

  const tooLong = await handleCreateTask(post({ title: "x".repeat(201) }), env);
  assert.equal(tooLong.status, 400);

  const badDate = await handleCreateTask(post({ title: "Reel", due: "21/08/2026" }), env);
  assert.equal(badDate.status, 400);
  assert.match((await badDate.json()).error, /YYYY-MM-DD/);
});

test("creating is refused outright when no content list is configured", async () => {
  await assert.rejects(
    () => handleCreateTask(post({ title: "Reel" }), { ...env, CLICKUP_CONTENT_LIST_ID: "" }),
    /no list to create in/,
  );
});
