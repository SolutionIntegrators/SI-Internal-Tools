// Budget and debt arithmetic. These are the numbers that would quietly mislead
// if they were wrong, so they are pinned without touching Airtable.
import test from "node:test";
import assert from "node:assert/strict";

import { budgetRows, debtRows } from "../src/lib/budget.js";
import { categoryFor, sumByCategory, UNCATEGORIZED } from "../src/lib/categoryMap.js";
import { handleSetBudget } from "../src/routes/moneyEdits.js";

const field = { category: "Category", budget: "Monthly Budget", group: "Group", note: "Notes" };
const row = (category, budget, group) => ({
  id: `rec${category.replace(/\W/g, "").padEnd(14, "x").slice(0, 14)}`,
  fields: { Category: category, "Monthly Budget": budget, Group: { name: group }, Notes: "" },
});
const RECORDS = [
  row("Contractors", 4949, "Operating Expense"),
  row("Software & subscriptions", 1325, "Operating Expense"),
  row("Wages", 4372, "Payroll"),
  row("IRS payment plan", 1900, "Debt / New Commitment"),
];

test("the messy QuickBooks types fold onto the clean budget names", () => {
  assert.equal(categoryFor("Cost of goods sold:Subcontractor expenses"), "Contractors");
  assert.equal(categoryFor("Subcontractor expenses"), "Contractors");
  assert.equal(categoryFor("Office expenses:Software & apps"), "Software & subscriptions");
  assert.equal(categoryFor("General business expenses:Memberships & subscriptions"), "Software & subscriptions");
  // A real typo in the option list, not a separate account.
  assert.equal(categoryFor("Merchant account feesh"), "Merchant account fees");
  // Specific beats general: this must not land in Wages.
  assert.equal(categoryFor("Payroll expenses:Wages:Owner's Health Insurance"), "Owner's Health Insurance");
  assert.equal(categoryFor("Interest paid:Credit card interest"), "Interest paid");
});

test("transfers and equity are ignored, unknowns are surfaced", () => {
  // Folding these into a category would overstate spend against it.
  for (const type of ["Owner draws", "Novo Primary Account", "Payments to deposit", "Opening balance equity"]) {
    assert.equal(categoryFor(type), null, type);
  }
  // No budget line exists for these — they must show up, not vanish.
  assert.equal(categoryFor("Federal estimated taxes"), UNCATEGORIZED);
  assert.equal(categoryFor("Something brand new"), UNCATEGORIZED);
  assert.equal(categoryFor(""), UNCATEGORIZED);
});

test("summing skips ignored types and zero amounts", () => {
  const totals = sumByCategory([
    { type: "Subcontractor expenses", amount: 1000 },
    { type: "Cost of goods sold:Subcontractor expenses", amount: 500 },
    { type: "Owner draws", amount: 5000 },
    { type: "Meals", amount: 0 },
    { type: "Federal estimated taxes", amount: 300 },
  ]);
  assert.deepEqual(totals, { Contractors: 1500, [UNCATEGORIZED]: 300 });
});

test("no actuals source leaves actual null, never zero", () => {
  // This is the important one: zero would render as "nothing spent, well under
  // budget". Null renders as "not connected".
  const { groups, totals } = budgetRows(RECORDS, null, { field });
  assert.equal(totals.actual, null);
  assert.equal(totals.budget, 4949 + 1325 + 4372 + 1900);
  for (const group of groups) {
    assert.equal(group.actual, null);
    for (const r of group.rows) {
      assert.equal(r.actual, null);
      assert.equal(r.variance, null);
      assert.equal(r.percent, null);
    }
  }
});

test("groups come back in reading order with their own totals", () => {
  const { groups } = budgetRows(RECORDS, {}, { field });
  assert.deepEqual(groups.map((g) => g.name), ["Operating Expense", "Payroll", "Debt / New Commitment"]);
  assert.equal(groups[0].budget, 4949 + 1325);
  // Biggest line first inside a group — that is the one worth watching.
  assert.deepEqual(groups[0].rows.map((r) => r.category), ["Contractors", "Software & subscriptions"]);
});

test("over and under budget are signed the way the card reads them", () => {
  const { groups } = budgetRows(RECORDS, { Contractors: 6000, Wages: 4000 }, { field });
  const contractors = groups[0].rows.find((r) => r.category === "Contractors");
  const wages = groups.find((g) => g.name === "Payroll").rows[0];
  assert.equal(contractors.variance, 1051, "positive means over");
  assert.equal(contractors.percent, 121);
  assert.equal(wages.variance, -372, "negative means under");
  assert.equal(wages.percent, 91); // 4000 / 4372 = 91.5%
});

test("spend with no budget line still appears, under Unbudgeted", () => {
  const { groups, totals } = budgetRows(RECORDS, { Contractors: 100, [UNCATEGORIZED]: 450 }, { field });
  const unbudgeted = groups.find((g) => g.name === "Unbudgeted");
  assert.ok(unbudgeted, "an Unbudgeted group should exist");
  assert.deepEqual(unbudgeted.rows.map((r) => r.category), ["Uncategorized"]);
  assert.equal(unbudgeted.rows[0].actual, 450);
  // Totals must reconcile with what actually left the account.
  assert.equal(totals.actual, 550);
});

test("a debt with no balances asks for setup instead of drawing a bar", () => {
  // Both of Ashley's debts are in exactly this state right now.
  const [irs] = debtRows(
    [{ id: "rec1", fields: { "Debt Name": "IRS Payment Plan", "Monthly Payment": 1900 } }],
    { field: { name: "Debt Name", start: "Starting Balance", current: "Current Balance", asOf: "As Of Date", payment: "Monthly Payment" } },
  );
  assert.equal(irs.needsSetup, true);
  assert.equal(irs.percent, null);
  assert.equal(irs.monthsLeft, null, "no balance means no honest pace");
  assert.equal(irs.payment, 1900);
});

test("payoff pace rounds up, because a part-month still needs a payment", () => {
  const f = { name: "Debt Name", start: "Starting Balance", current: "Current Balance", asOf: "As Of Date", payment: "Monthly Payment" };
  const [debt] = debtRows(
    [{ id: "rec1", fields: { "Debt Name": "IRS", "Starting Balance": 20000, "Current Balance": 8000, "Monthly Payment": 1900 } }],
    { field: f },
  );
  assert.equal(debt.paidOff, 12000);
  assert.equal(debt.percent, 60);
  assert.equal(debt.monthsLeft, 5, "8000 / 1900 is 4.2 — the fifth payment is what clears it");
  assert.equal(debt.needsSetup, false);

  // Paid off entirely: no months left, and the bar is full rather than negative.
  const [done] = debtRows(
    [{ id: "rec2", fields: { "Debt Name": "Card", "Starting Balance": 5000, "Current Balance": 0, "Monthly Payment": 300 } }],
    { field: f },
  );
  assert.equal(done.monthsLeft, null);
  assert.equal(done.needsSetup, true, "a zero balance has nothing left to track");
});

test("editing a budget rejects junk before it reaches Airtable", async () => {
  const env = { AIRTABLE_MONEY_BASE_ID: "appfVpfMqptf35xRa", AIRTABLE_BUDGETS_TABLE: "Category Budgets" };
  const post = (body) => new Request("https://x/", { method: "POST", body: JSON.stringify(body) });

  assert.equal((await handleSetBudget(post({ amount: 100 }), env, "not-a-record")).status, 400);
  assert.equal((await handleSetBudget(post({ amount: -5 }), env, "rec1Wk3YRvfZxaV1n")).status, 400);
  assert.equal((await handleSetBudget(post({ amount: "abc" }), env, "rec1Wk3YRvfZxaV1n")).status, 400);
  const typo = await handleSetBudget(post({ amount: 5000000 }), env, "rec1Wk3YRvfZxaV1n");
  assert.equal(typo.status, 400);
  assert.match((await typo.json()).error, /typo/);
});
