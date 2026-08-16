import test from "node:test";
import assert from "node:assert/strict";
import { occurrencesInWindow } from "../src/lib/recurrence.js";

test("one-time items land only on their own date", () => {
  const item = { frequency: "One-time", anchorDate: "2026-08-20" };
  assert.deepEqual(occurrencesInWindow(item, "2026-08-17", "2026-08-24"), ["2026-08-20"]);
  assert.deepEqual(occurrencesInWindow(item, "2026-08-21", "2026-08-28"), []);
});

test("monthly items land on their day of the month", () => {
  const item = { frequency: "Monthly", dayOfMonth: 20 };
  assert.deepEqual(occurrencesInWindow(item, "2026-08-17", "2026-08-24"), ["2026-08-20"]);
  assert.deepEqual(occurrencesInWindow(item, "2026-08-21", "2026-08-28"), []);
});

test("a monthly bill set past the end of a short month still comes due", () => {
  const item = { frequency: "Monthly", dayOfMonth: 31 };
  // February 2026 has 28 days, so the 31st clamps to the 28th rather than
  // disappearing for the month.
  assert.deepEqual(occurrencesInWindow(item, "2026-02-22", "2026-03-01"), ["2026-02-28"]);
});

test("monthly items can appear twice in a long enough window", () => {
  const item = { frequency: "Monthly", dayOfMonth: 1 };
  assert.deepEqual(occurrencesInWindow(item, "2026-07-15", "2026-09-05"), ["2026-08-01", "2026-09-01"]);
});

test("weekly items land on their weekday", () => {
  const item = { frequency: "Weekly", weekday: "Fri" };
  assert.deepEqual(occurrencesInWindow(item, "2026-08-17", "2026-08-24"), ["2026-08-21"]);
  assert.deepEqual(occurrencesInWindow(item, "2026-08-17", "2026-08-31"), ["2026-08-21", "2026-08-28"]);
});

test("every-2-weeks follows the anchor's cadence, forwards and backwards", () => {
  const item = { frequency: "Every 2 Weeks", anchorDate: "2026-08-07" };
  assert.deepEqual(occurrencesInWindow(item, "2026-08-17", "2026-08-24"), ["2026-08-21"]);
  // An anchor far in the past still produces the right dates today.
  const old = { frequency: "Every 2 Weeks", anchorDate: "2024-01-05" };
  const dates = occurrencesInWindow(old, "2026-08-17", "2026-08-31");
  for (const date of dates) {
    const gap = (Date.parse(date) - Date.parse("2024-01-05")) / 86400000;
    assert.equal(gap % 14, 0, `${date} is not on the 14-day cadence`);
  }
  assert.equal(dates.length, 1);
});

test("an anchor in the future is not projected backwards", () => {
  const item = { frequency: "Every 2 Weeks", anchorDate: "2026-09-04" };
  assert.deepEqual(occurrencesInWindow(item, "2026-08-17", "2026-08-24"), []);
});

test("quarterly items keep the anchor's month spacing", () => {
  const item = { frequency: "Quarterly", dayOfMonth: 15, anchorDate: "2026-02-15" };
  assert.deepEqual(occurrencesInWindow(item, "2026-08-10", "2026-08-20"), ["2026-08-15"]);
  // September is not on the quarterly cadence from February.
  assert.deepEqual(occurrencesInWindow(item, "2026-09-10", "2026-09-20"), []);
});

test("rules missing the field they need produce nothing rather than guessing", () => {
  assert.deepEqual(occurrencesInWindow({ frequency: "Weekly" }, "2026-08-17", "2026-08-24"), []);
  assert.deepEqual(occurrencesInWindow({ frequency: "Monthly" }, "2026-08-17", "2026-08-24"), []);
  assert.deepEqual(occurrencesInWindow({ frequency: "Every 2 Weeks" }, "2026-08-17", "2026-08-24"), []);
  assert.deepEqual(occurrencesInWindow({ frequency: "Nonsense" }, "2026-08-17", "2026-08-24"), []);
});
