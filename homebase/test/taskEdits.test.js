// The two write actions, tested at the level that can go wrong: picking the
// right "done" status for a list, and turning a date into what ClickUp wants.
import test from "node:test";
import assert from "node:assert/strict";
import { pickClosedStatus, dueDateToMs, validTaskId } from "../src/lib/taskEdits.js";

const env = {};

test("the done status comes from the type flag, whatever it is called", () => {
  const statuses = [
    { status: "to do", type: "open" },
    { status: "in progress", type: "custom" },
    { status: "shipped", type: "closed" },
  ];
  assert.equal(pickClosedStatus(statuses, env), "shipped");
});

test("a done-typed status is used when there is no closed one", () => {
  const statuses = [
    { status: "to do", type: "open" },
    { status: "complete", type: "done" },
  ];
  assert.equal(pickClosedStatus(statuses, env), "complete");
});

test("statuses fall back to matching by name", () => {
  const statuses = [
    { status: "to do", type: "open" },
    { status: "Closed", type: "custom" },
  ];
  assert.equal(pickClosedStatus(statuses, env), "Closed");
});

test("a list with nowhere to mark done returns nothing rather than guessing", () => {
  assert.equal(pickClosedStatus([{ status: "to do", type: "open" }], env), null);
  assert.equal(pickClosedStatus([], env), null);
  assert.equal(pickClosedStatus(undefined, env), null);
});

test("due dates land on the intended day in every timezone the business uses", () => {
  const ms = dueDateToMs("2026-08-20");
  // Midday UTC keeps the calendar date stable from Chicago through to Sydney,
  // which is the whole point of not using midnight.
  for (const timeZone of ["America/Chicago", "America/New_York", "UTC", "Australia/Sydney"]) {
    const rendered = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(ms));
    assert.equal(rendered, "2026-08-20", `wrong day in ${timeZone}`);
  }
});

test("clearing a due date sends null, and junk is rejected", () => {
  assert.equal(dueDateToMs(null), null);
  assert.equal(dueDateToMs(""), null);
  assert.throws(() => dueDateToMs("20-08-2026"), /YYYY-MM-DD/);
  assert.throws(() => dueDateToMs("2026-13-45"), /not a real date/);
});

test("task ids are validated before they reach a URL", () => {
  assert.ok(validTaskId("86a1b2c3d"));
  assert.ok(validTaskId("abc-123_XY"));
  assert.ok(!validTaskId("../../etc/passwd"));
  assert.ok(!validTaskId("86a1/status"));
  assert.ok(!validTaskId(""));
  assert.ok(!validTaskId(undefined));
});
