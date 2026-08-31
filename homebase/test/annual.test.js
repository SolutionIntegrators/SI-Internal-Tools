// Pinned against a real year of Financial Summary rows (2026), so a future
// change to the rounding or averaging rules shows up here before it reaches
// the numbers Ashley already trusts from Airtable's own dashboard.
import test from "node:test";
import assert from "node:assert/strict";

import { MONTH_NAMES, annualSummary } from "../src/lib/annual.js";

const row = (month, goal, actual, projected, hasRow = true) => ({ month, goal, actual, projected, hasRow });

// Unrounded, straight from Airtable — several months carry cents.
const YEAR_2026 = [
  row("January", 25000, 30664, 30664),
  row("February", 30000, 37594, 37594),
  row("March", 10000, 24185.66, 24185.66),
  row("April", 25000, 17005.67, 17005.67),
  row("May", 20000, 17230.67, 17230.67),
  row("June", 12000, 14667, 14667),
  row("July", 15000, 21904.5, 21904.5),
  row("August", 20000, 13812.5, 13812.5),
  row("September", 20000, 8812.5, 16375),
  row("October", 20000, 5812.5, 10875),
  row("November", 20000, 0, 3750),
  row("December", 20000, 0, 3750),
];

test("annual summary matches Airtable's own Year over Year Stats tiles", () => {
  const summary = annualSummary(2026, YEAR_2026);
  assert.equal(summary.year, 2026);
  assert.equal(summary.annualSales, 191689);
  assert.equal(summary.projectedTotal, 211814);
  assert.equal(summary.goalTotal, 237000);
  assert.equal(summary.distanceToGoal, -45311);
  assert.equal(summary.averageMonthlySales, 15974); // 191689 / 12, rounded
  assert.equal(summary.months.length, 12);
  assert.deepEqual(
    summary.months.map((m) => m.month),
    MONTH_NAMES,
  );
  // Individual months are rounded for display...
  assert.equal(summary.months[2].actual, 24186); // March: 24185.66 rounded
  // ...but the total above was summed before any of that rounding happened,
  // so it can't drift away from Airtable's own sum the way round-then-sum
  // over 12 rows would (24186 + ... would overshoot 191689 by a few dollars).
  assert.ok(!("hasRow" in summary.months[0]));
});

test("a month with no row yet counts as zero but does not water down the average", () => {
  const partial = [
    row("January", 10000, 10000, 10000),
    row("February", 10000, 20000, 20000),
    row("March", 10000, 0, 0, false), // no row created for March yet
  ];
  const summary = annualSummary(2026, partial);
  assert.equal(summary.annualSales, 30000);
  // Averaged over the 2 rows that exist, not all 3 slots.
  assert.equal(summary.averageMonthlySales, 15000);
  assert.equal(summary.months[2].actual, 0);
});

test("an empty year (no rows at all) degrades to zeros, not NaN", () => {
  const empty = MONTH_NAMES.map((month) => ({ month, goal: 0, actual: 0, projected: 0, hasRow: false }));
  const summary = annualSummary(2027, empty);
  assert.equal(summary.annualSales, 0);
  assert.equal(summary.distanceToGoal, 0);
  assert.equal(summary.averageMonthlySales, 0);
});
