// GET /api/dashboard/money — Airtable.
//
// Three bases, each shaped differently:
//   SI Money Metrics          Income Tracking (revenue), Invoice Tracking (owed)
//   99 Problems ...           Recurring Items (bills as recurrence rules),
//                             Weekly Revenue Goals (this week's target)
import { json, softly } from "../lib/http.js";
import { localDate, startOfWeek, endOfWeek, addDays } from "../lib/dates.js";
import * as airtable from "../services/airtable.js";
import { occurrencesInWindow } from "../lib/recurrence.js";
import { revenueNote } from "../lib/filters.js";
import { readSnapshot, writeSnapshot } from "../lib/cache.js";
import { isSettled } from "../lib/moneyEdits.js";

// Invoices in these states are settled or abandoned — neither is money coming in.
const CLOSED_INVOICE_STATUSES = ["paid", "project cancelled", "delete"];

export async function handleMoney(env, ctx) {
  const tz = env.TIMEZONE;
  const now = new Date();
  const today = localDate(now, tz);
  const weekStart = startOfWeek(now, tz); // Sunday
  const weekEnd = endOfWeek(now, tz); // Saturday
  const warnings = [];

  const [collected, weeklyGoal, invoices, recurring] = await Promise.all([
    softly(warnings, "Revenue", fetchCollected(env, weekStart, today), []),
    softly(warnings, "Weekly goal", fetchWeeklyGoal(env, weekStart, weekEnd), null),
    softly(warnings, "Upcoming payments", fetchOpenInvoices(env, today), []),
    softly(warnings, "Bills", fetchRecurringExpenses(env), []),
  ]);

  const goal = weeklyGoal ?? Number(env.REVENUE_GOAL || 7500);
  const field = fields(env);
  const current = collected.reduce(
    (total, record) => total + airtable.toAmount(record.fields?.[field.incomeAmount]),
    0,
  );

  const payload = {
    revenue: { goal, current: Math.round(current), note: revenueNote(current, goal) },
    upcomingPayments: invoices.slice(0, 5).map((record) => ({
      id: record.id,
      client: clientFromSummary(airtable.toText(record.fields?.[field.invoiceSummary])),
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
function clientFromSummary(summary) {
  return summary.split("|")[0].trim() || summary || "Unnamed";
}

export async function cachedMoney(env) {
  return readSnapshot(env, "money");
}
