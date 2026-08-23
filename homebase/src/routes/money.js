// GET /api/dashboard/money — Airtable.
//
// Three bases, each shaped differently:
//   SI Money Metrics          Income Tracking (revenue), Invoice Tracking (owed)
//   SI Money Metrics          Financial Summary (the month's goal and actual)
//   99 Problems ...           Recurring Items (bills as recurrence rules),
//                             Weekly Revenue Goals (this week's target)
import { json, softly } from "../lib/http.js";
import { localDate, startOfWeek, endOfWeek, addDays } from "../lib/dates.js";
import * as airtable from "../services/airtable.js";
import { occurrencesInWindow } from "../lib/recurrence.js";
import { revenueNote } from "../lib/filters.js";
import { readSnapshot, writeSnapshot } from "../lib/cache.js";
import { isSettled } from "../lib/moneyEdits.js";
import { budgetRows, debtRows } from "../lib/budget.js";
import { sumByCategory } from "../lib/categoryMap.js";

// Invoices in these states are settled or abandoned — neither is money coming in.
const CLOSED_INVOICE_STATUSES = ["paid", "project cancelled", "delete"];

export async function handleMoney(env, ctx) {
  const tz = env.TIMEZONE;
  const now = new Date();
  const today = localDate(now, tz);
  const weekStart = startOfWeek(now, tz); // Sunday
  const weekEnd = endOfWeek(now, tz); // Saturday
  const warnings = [];

  const [collected, weeklyGoal, invoices, recurring, summary, budget, debts] = await Promise.all([
    softly(warnings, "Revenue", fetchCollected(env, weekStart, today), []),
    softly(warnings, "Weekly goal", fetchWeeklyGoal(env, weekStart, weekEnd), null),
    softly(warnings, "Upcoming payments", fetchOpenInvoices(env, today), []),
    softly(warnings, "Bills", fetchRecurringExpenses(env), []),
    softly(warnings, "Month", fetchMonthSummary(env, now, tz), null),
    softly(warnings, "Budget", fetchBudget(env, today), null),
    softly(warnings, "Debts", fetchDebts(env), []),
  ]);

  const goal = weeklyGoal ?? Number(env.REVENUE_GOAL || 7500);
  const field = fields(env);
  const current = collected.reduce(
    (total, record) => total + airtable.toAmount(record.fields?.[field.incomeAmount]),
    0,
  );

  const payload = {
    revenue: { goal, current: Math.round(current), note: revenueNote(current, goal) },
    // The month is its own question and its own row in Airtable: the goal is
    // set there rather than derived from the weekly one, and "projected" is
    // collected plus everything still invoiced — not a run-rate guess.
    month: summary,
    budget,
    debts,
    upcomingPayments: invoices.slice(0, 5).map((record) => ({
      id: record.id,
      client: clientFromSummary(
        airtable.toText(record.fields?.[field.invoiceSummary]),
        airtable.toText(record.fields?.[field.invoiceNotes]),
      ),
      amount: airtable.formatMoney(
        airtable.toAmount(record.fields?.[field.invoiceAmount]) ||
          airtable.toAmount(record.fields?.[field.invoiceTotal]),
      ),
      expected: String(record.fields?.[field.invoiceDue] || "").slice(0, 10),
      status: airtable.toText(record.fields?.[field.invoiceStatus]),
    })),
    upcomingBills: billsDueSoon(recurring, { env, today }),
    // The bills card only offers a paid checkbox when there is a column to
    // record it in, so a missing field degrades to read-only rather than to a
    // button that always fails.
    billsWritable: Boolean(env.AIRTABLE_BILLS_PAID_THROUGH_FIELD),
    week: { start: weekStart, end: weekEnd },
    warnings,
  };

  ctx.waitUntil(writeSnapshot(env, "money", payload));
  return json(payload);
}

// Field names are configurable because Airtable columns get renamed, but the
// defaults are the live ones rather than guesses.
function fields(env) {
  return {
    incomeDate: env.AIRTABLE_INCOME_DATE_FIELD || "Date",
    incomeAmount: env.AIRTABLE_INCOME_AMOUNT_FIELD || "Payment Amount",
    incomeStatus: env.AIRTABLE_INCOME_STATUS_FIELD || "Status",
    invoiceSummary: env.AIRTABLE_INVOICE_SUMMARY_FIELD || "Summary",
    invoiceStatus: env.AIRTABLE_INVOICE_STATUS_FIELD || "Status",
    invoiceNotes: env.AIRTABLE_INVOICE_NOTES_FIELD || "Notes",
    invoiceDue: env.AIRTABLE_INVOICE_DUE_FIELD || "Due Date",
    invoiceAmount: env.AIRTABLE_INVOICE_AMOUNT_FIELD || "Payment Amount",
    invoiceTotal: env.AIRTABLE_INVOICE_TOTAL_FIELD || "Invoice Total",
  };
}

/**
 * A row in Income Tracking is money that came in — the Date is when it landed.
 * Status is an optional annotation and is blank on most rows, so requiring
 * Status = "Paid" would report almost nothing. Exclude what is explicitly
 * marked unpaid instead, and count the rest.
 */
async function fetchCollected(env, weekStart, today) {
  if (!env.AIRTABLE_MONEY_BASE_ID) return [];
  const field = fields(env);
  const excluded = (env.AIRTABLE_INCOME_EXCLUDE_STATUSES || "Unpaid")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const notExcluded = excluded.length
    ? `, NOT(OR(${excluded.map((value) => `{${field.incomeStatus}} = ${airtable.quote(value)}`).join(", ")}))`
    : "";
  return airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, env.AIRTABLE_INCOME_TABLE, {
    filterByFormula: `AND(${airtable.dateRangeFormula(field.incomeDate, weekStart, today)}${notExcluded})`,
    maxRecords: 100,
  });
}

/** Category Budgets plus this month's actuals, if anything can supply them. */
async function fetchBudget(env, today) {
  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_BUDGETS_TABLE) return null;

  const field = {
    category: env.AIRTABLE_BUDGET_CATEGORY_FIELD || "Category",
    budget: env.AIRTABLE_BUDGET_AMOUNT_FIELD || "Monthly Budget",
    group: env.AIRTABLE_BUDGET_GROUP_FIELD || "Group",
    note: env.AIRTABLE_BUDGET_NOTES_FIELD || "Notes",
  };

  const [records, actuals] = await Promise.all([
    airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, env.AIRTABLE_BUDGETS_TABLE, { maxRecords: 100 }),
    fetchActuals(env, today),
  ]);

  return {
    month: today.slice(0, 7),
    ...budgetRows(records, actuals.byCategory, { field }),
    // Named so the card can say where the numbers came from, or that nothing
    // is supplying them yet.
    actualsSource: actuals.source,
  };
}

/**
 * This month's spend per category.
 *
 * There is deliberately no default source. Airtable's expense tables
 * (z_Expense Tracking, z_Monthly Spend) stopped being written to in 2023 —
 * summing them would report $0 spent against every category, which reads as
 * "you are well under budget" rather than "nothing is connected". So actuals
 * stay null until BUDGET_ACTUALS_SOURCE names something real, and the card
 * says so.
 */
async function fetchActuals(env, today) {
  const source = env.BUDGET_ACTUALS_SOURCE || "";
  if (source !== "airtable-expenses") return { byCategory: null, source: null };

  const table = env.AIRTABLE_EXPENSES_TABLE || "z_Expense Tracking";
  const dateField = env.AIRTABLE_EXPENSE_DATE_FIELD || "Date";
  const typeField = env.AIRTABLE_EXPENSE_TYPE_FIELD || "Type";
  const costField = env.AIRTABLE_EXPENSE_COST_FIELD || "Cost";

  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = addDays(`${nextMonth(today)}-01`, -1);

  const records = await airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, table, {
    filterByFormula: airtable.dateRangeFormula(dateField, monthStart, monthEnd),
    maxRecords: 1000,
  });

  return {
    byCategory: sumByCategory(
      records.map((record) => ({
        type: airtable.toText(record.fields?.[typeField]),
        amount: airtable.toAmount(record.fields?.[costField]),
      })),
    ),
    source: table,
  };
}

function nextMonth(isoDate) {
  const [year, month] = isoDate.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

async function fetchDebts(env) {
  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_DEBTS_TABLE) return [];
  const records = await airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, env.AIRTABLE_DEBTS_TABLE, {
    maxRecords: 50,
  });
  return debtRows(records, {
    field: {
      name: env.AIRTABLE_DEBT_NAME_FIELD || "Debt Name",
      start: env.AIRTABLE_DEBT_START_FIELD || "Starting Balance",
      current: env.AIRTABLE_DEBT_CURRENT_FIELD || "Current Balance",
      asOf: env.AIRTABLE_DEBT_ASOF_FIELD || "As Of Date",
      payment: env.AIRTABLE_DEBT_PAYMENT_FIELD || "Monthly Payment",
    },
  });
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The month's goal, actual and projected close, from the one row per month in
 * the Financial Summary table. Everything here is already computed in Airtable
 * — the dashboard reads it rather than recomputing it, so the two can never
 * disagree about what the month looks like.
 */
async function fetchMonthSummary(env, now, tz) {
  const table = env.AIRTABLE_SUMMARY_TABLE;
  if (!env.AIRTABLE_MONEY_BASE_ID || !table) return null;

  const local = localDate(now, tz);
  const monthName = MONTH_NAMES[Number(local.slice(5, 7)) - 1];
  const year = local.slice(0, 4);

  const monthField = env.AIRTABLE_SUMMARY_MONTH_FIELD || "Month";
  const yearField = env.AIRTABLE_SUMMARY_YEAR_FIELD || "Year";
  const goalField = env.AIRTABLE_SUMMARY_GOAL_FIELD || "🎯 Income";
  const actualField = env.AIRTABLE_SUMMARY_ACTUAL_FIELD || "💪🏾Total Income";
  const projectedField = env.AIRTABLE_SUMMARY_PROJECTED_FIELD || "🤔 Expected Income";

  const records = await airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, table, {
    filterByFormula: `AND({${monthField}} = ${airtable.quote(monthName)}, {${yearField}} = ${airtable.quote(year)})`,
    maxRecords: 1,
  });
  const row = records[0];
  if (!row) return null;

  const goal = airtable.toAmount(row.fields?.[goalField]);
  const actual = airtable.toAmount(row.fields?.[actualField]);
  const projected = airtable.toAmount(row.fields?.[projectedField]);

  return {
    label: `${monthName} ${year}`,
    goal: Math.round(goal),
    actual: Math.round(actual),
    projected: Math.round(projected),
    // Positive means ahead. Both are reported because "behind on collections"
    // and "behind even once everything invoiced lands" are different problems:
    // the first is chasing, the second is selling.
    toGoal: Math.round(actual - goal),
    projectedToGoal: Math.round(projected - goal),
  };
}

/**
 * The weekly target lives in Airtable, so changing it there changes the
 * dashboard. Matched on the goal row falling anywhere inside this Sun-Sat week
 * rather than on the exact start date: the Weekly Revenue Goals rows are all
 * dated Mondays, and an exact match against Sunday would find nothing and
 * silently fall back to REVENUE_GOAL every single week.
 */
async function fetchWeeklyGoal(env, weekStart, weekEnd) {
  if (!env.AIRTABLE_BILLS_BASE_ID || !env.AIRTABLE_GOALS_TABLE) return null;
  const weekField = env.AIRTABLE_GOALS_WEEK_FIELD || "Week Start Date";
  const goalField = env.AIRTABLE_GOALS_AMOUNT_FIELD || "Goal Amount";
  const records = await airtable.listRecords(env, env.AIRTABLE_BILLS_BASE_ID, env.AIRTABLE_GOALS_TABLE, {
    filterByFormula: airtable.dateRangeFormula(weekField, weekStart, weekEnd),
    maxRecords: 1,
  });
  const amount = airtable.toAmount(records[0]?.fields?.[goalField]);
  return amount > 0 ? amount : null;
}

async function fetchOpenInvoices(env, today) {
  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_INVOICE_TABLE) return [];
  const field = fields(env);
  const records = await airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, env.AIRTABLE_INVOICE_TABLE, {
    filterByFormula: `IS_AFTER({${field.invoiceDue}}, ${airtable.quote(addDays(today, -1))})`,
    sort: [{ field: field.invoiceDue, direction: "asc" }],
    maxRecords: 50,
  });
  // Status is filtered here rather than in the formula: a blank status should
  // still show as money owed, and Airtable formulas make that awkward.
  return records.filter(
    (record) => !CLOSED_INVOICE_STATUSES.includes(airtable.toText(record.fields?.[field.invoiceStatus]).toLowerCase()),
  );
}

async function fetchRecurringExpenses(env) {
  if (!env.AIRTABLE_BILLS_BASE_ID || !env.AIRTABLE_BILLS_TABLE) return [];
  return airtable.listRecords(env, env.AIRTABLE_BILLS_BASE_ID, env.AIRTABLE_BILLS_TABLE, {
    maxRecords: 200,
  });
}


/**
 * Expand the recurrence rules into actual dates and keep the expenses landing
 * within `days` of `today` — 7 for the card, a whole grid for the calendar. Inactive rules are skipped — the checkbox is Ashley's
 * off switch, and Airtable omits it entirely when unchecked.
 */
export function billsDueSoon(records, { env, today, days = 7, limit = 5 }) {
  const horizon = addDays(today, days);
  const paidField = env.AIRTABLE_BILLS_PAID_THROUGH_FIELD || "";
  const books = (env.AIRTABLE_BILLS_BOOKS || "")
    .split(",")
    .map((book) => book.trim().toLowerCase())
    .filter(Boolean);

  const nameField = env.AIRTABLE_BILLS_NAME_FIELD || "Name";
  const amountField = env.AIRTABLE_BILLS_AMOUNT_FIELD || "Amount";
  const typeField = env.AIRTABLE_BILLS_TYPE_FIELD || "Type";
  const bookField = env.AIRTABLE_BILLS_BOOK_FIELD || "Book";
  const activeField = env.AIRTABLE_BILLS_ACTIVE_FIELD || "Active";
  const expenseValue = (env.AIRTABLE_BILLS_EXPENSE_VALUE || "Expense").toLowerCase();

  const due = [];
  for (const record of records) {
    const f = record.fields || {};
    if (f[activeField] !== true) continue;
    if (airtable.toText(f[typeField]).toLowerCase() !== expenseValue) continue;

    const book = airtable.toText(f[bookField]);
    if (books.length && !books.includes(book.toLowerCase())) continue;

    const dates = occurrencesInWindow(
      {
        frequency: airtable.toText(f[env.AIRTABLE_BILLS_FREQUENCY_FIELD || "Frequency"]),
        dayOfMonth: Number(f[env.AIRTABLE_BILLS_DAY_FIELD || "Day of Month"]) || 0,
        weekday: airtable.toText(f[env.AIRTABLE_BILLS_WEEKDAY_FIELD || "Weekday"]),
        anchorDate: String(f[env.AIRTABLE_BILLS_ANCHOR_FIELD || "Anchor or One-Time Date"] || "").slice(0, 10),
      },
      today,
      horizon,
    );

    // Occurrences up to the Paid Through mark are already settled. The rule
    // keeps running, so next month's copy of the bill still appears.
    const paidThrough = paidField ? String(f[paidField] || "").slice(0, 10) : "";

    for (const date of dates) {
      if (isSettled(date, paidThrough)) continue;
      due.push({
        id: record.id,
        name: airtable.toText(f[nameField]) || "Unnamed",
        amount: airtable.formatMoney(airtable.toAmount(f[amountField])),
        due: date,
        book,
        paidThrough: paidThrough || null,
      });
    }
  }

  return due.sort((a, b) => a.due.localeCompare(b.due)).slice(0, limit);
}

/** Invoice summaries read "Client | Service ($amount)". The client is the useful half. */
/**
 * Summary is an Airtable formula built from the linked service record, so an
 * invoice added from the dashboard has none until it is linked up. Notes is the
 * one field the dashboard can write, so it is the fallback rather than showing
 * a row called "Unnamed".
 */
function clientFromSummary(summary, notes = "") {
  const fromSummary = summary.split("|")[0].trim();
  return fromSummary || summary || notes.trim() || "Unnamed";
}

export async function cachedMoney(env) {
  return readSnapshot(env, "money");
}
