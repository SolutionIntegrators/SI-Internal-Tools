// POST /api/money/invoices/:id/status  — mark an invoice paid, or put it back
// POST /api/money/invoices/:id/due     — move the expected date
// POST /api/money/bills/:id/paid       — record a bill occurrence as paid
// POST /api/money/bills/:id/paid-through — set the mark explicitly (undo)
//
// Every one of these reads the record first and hands back its prior value, so
// the page can offer a real undo rather than guessing what it overwrote.
// Support tickets and the content pipeline stay read-only.

import { json, badRequest, ConfigError } from "../lib/http.js";
import * as airtable from "../services/airtable.js";
import {
  validRecordId,
  normalizeDate,
  resolveInvoiceStatus,
  allowedInvoiceStatuses,
  advancePaidThrough,
} from "../lib/moneyEdits.js";

const INVOICE_STATUS_FIELD = (env) => env.AIRTABLE_INVOICE_STATUS_FIELD || "Status";
const INVOICE_DUE_FIELD = (env) => env.AIRTABLE_INVOICE_DUE_FIELD || "Due Date";
const BILLS_PAID_FIELD = (env) => env.AIRTABLE_BILLS_PAID_THROUGH_FIELD || "";

function invoiceTarget(env) {
  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_INVOICE_TABLE) {
    throw new ConfigError("the invoice table is not set");
  }
  return { baseId: env.AIRTABLE_MONEY_BASE_ID, table: env.AIRTABLE_INVOICE_TABLE };
}

function billTarget(env) {
  if (!env.AIRTABLE_BILLS_BASE_ID || !env.AIRTABLE_BILLS_TABLE) {
    throw new ConfigError("the recurring items table is not set");
  }
  if (!BILLS_PAID_FIELD(env)) {
    throw new ConfigError(
      "AIRTABLE_BILLS_PAID_THROUGH_FIELD is not set, so there is nowhere to record a paid bill",
    );
  }
  return { baseId: env.AIRTABLE_BILLS_BASE_ID, table: env.AIRTABLE_BILLS_TABLE };
}

export async function handleInvoiceStatus(request, env, recordId) {
  if (!validRecordId(recordId)) return badRequest("Bad invoice id");
  const body = await request.json().catch(() => ({}));

  const status = resolveInvoiceStatus(env, body.status);
  if (!status) {
    return badRequest(`Status must be one of: ${allowedInvoiceStatuses(env).join(", ")}`);
  }

  const { baseId, table } = invoiceTarget(env);
  const field = INVOICE_STATUS_FIELD(env);
  const before = await airtable.getRecord(env, baseId, table, recordId);
  const previousStatus = airtable.toText(before?.fields?.[field]) || null;

  await airtable.updateRecord(env, baseId, table, recordId, { [field]: status });
  return json({ ok: true, status, previousStatus });
}

export async function handleInvoiceDue(request, env, recordId) {
  if (!validRecordId(recordId)) return badRequest("Bad invoice id");
  const body = await request.json().catch(() => ({}));

  let due;
  try {
    due = normalizeDate(body.due ?? null);
  } catch (err) {
    return badRequest(err.message);
  }

  const { baseId, table } = invoiceTarget(env);
  const field = INVOICE_DUE_FIELD(env);
  const before = await airtable.getRecord(env, baseId, table, recordId);
  const previousDue = String(before?.fields?.[field] || "").slice(0, 10) || null;

  await airtable.updateRecord(env, baseId, table, recordId, { [field]: due });
  return json({ ok: true, due, previousDue });
}

/**
 * Marking a bill paid moves the Paid Through mark to that occurrence's date.
 * The rule itself is untouched, so next month's copy of the bill still shows up.
 */
export async function handleBillPaid(request, env, recordId) {
  if (!validRecordId(recordId)) return badRequest("Bad bill id");
  const body = await request.json().catch(() => ({}));

  // Validate before reaching for the record: a malformed request should never
  // cost an Airtable round trip, and a 400 should not depend on one succeeding.
  let occurrence;
  try {
    occurrence = normalizeDate(body.due ?? null);
    if (!occurrence) throw new Error("Expected the occurrence date being paid");
  } catch (err) {
    return badRequest(err.message);
  }

  const { baseId, table } = billTarget(env);
  const field = BILLS_PAID_FIELD(env);
  const before = await airtable.getRecord(env, baseId, table, recordId);
  const previousPaidThrough = String(before?.fields?.[field] || "").slice(0, 10) || null;
  const paidThrough = advancePaidThrough(previousPaidThrough, occurrence);

  await airtable.updateRecord(env, baseId, table, recordId, { [field]: paidThrough });
  return json({ ok: true, paidThrough, previousPaidThrough });
}

/** Undo for the above: put the mark back exactly where it was, blank included. */
export async function handleBillPaidThrough(request, env, recordId) {
  if (!validRecordId(recordId)) return badRequest("Bad bill id");
  const body = await request.json().catch(() => ({}));

  let paidThrough;
  try {
    paidThrough = normalizeDate(body.paidThrough ?? null);
  } catch (err) {
    return badRequest(err.message);
  }

  const { baseId, table } = billTarget(env);
  await airtable.updateRecord(env, baseId, table, recordId, { [BILLS_PAID_FIELD(env)]: paidThrough });
  return json({ ok: true, paidThrough });
}

/**
 * POST /api/money/invoices — add an expected payment.
 *
 * Summary on Invoice Tracking is a formula off the linked service record, so
 * the dashboard cannot set it. The client name goes in Notes, which is the one
 * free-text column, and the read side falls back to it — so a row added here
 * shows the right name on the card even before anyone links it to a service.
 */
export async function handleCreateInvoice(request, env) {
  const body = await request.json().catch(() => ({}));

  const client = typeof body.client === "string" ? body.client.trim() : "";
  if (!client) return badRequest("Who is the payment from?");
  if (client.length > 120) return badRequest("That name is too long");

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return badRequest("Enter an amount greater than zero");

  let due;
  try {
    due = normalizeDate(body.due ?? null);
  } catch (err) {
    return badRequest(err.message);
  }

  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_INVOICE_TABLE) {
    throw new ConfigError("the invoice table is not set");
  }

  const created = await airtable.createRecord(env, env.AIRTABLE_MONEY_BASE_ID, env.AIRTABLE_INVOICE_TABLE, {
    [env.AIRTABLE_INVOICE_NOTES_FIELD || "Notes"]: client,
    [env.AIRTABLE_INVOICE_AMOUNT_FIELD || "Payment Amount"]: amount,
    [INVOICE_DUE_FIELD(env)]: due,
    [INVOICE_STATUS_FIELD(env)]: "In progress",
  });

  return json({ ok: true, id: created.id, client, amount, due });
}

/**
 * POST /api/money/bills — add a recurring item.
 *
 * Recurring Items are rules, so a bill needs a frequency and the anchor that
 * frequency reads: a day of the month, a weekday, or an exact date. Sending the
 * wrong anchor for the frequency is the easy mistake, so it is checked here
 * rather than left to produce a rule that silently never fires.
 */
export async function handleCreateBill(request, env) {
  const body = await request.json().catch(() => ({}));

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return badRequest("Give the bill a name");
  if (name.length > 120) return badRequest("That name is too long");

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return badRequest("Enter an amount greater than zero");

  const frequency = typeof body.frequency === "string" ? body.frequency.trim() : "";
  const allowed = ["Monthly", "Weekly", "Every 2 Weeks", "Quarterly", "One-time"];
  const resolved = allowed.find((option) => option.toLowerCase() === frequency.toLowerCase());
  if (!resolved) return badRequest(`Frequency must be one of: ${allowed.join(", ")}`);

  const fields = {
    [env.AIRTABLE_BILLS_NAME_FIELD || "Name"]: name,
    [env.AIRTABLE_BILLS_AMOUNT_FIELD || "Amount"]: amount,
    [env.AIRTABLE_BILLS_TYPE_FIELD || "Type"]: "Expense",
    [env.AIRTABLE_BILLS_FREQUENCY_FIELD || "Frequency"]: resolved,
    [env.AIRTABLE_BILLS_ACTIVE_FIELD || "Active"]: true,
  };
  if (body.book) fields[env.AIRTABLE_BILLS_BOOK_FIELD || "Book"] = String(body.book);

  if (resolved === "Monthly" || resolved === "Quarterly") {
    const day = Number(body.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return badRequest(`A ${resolved.toLowerCase()} bill needs a day of the month between 1 and 31`);
    }
    fields[env.AIRTABLE_BILLS_DAY_FIELD || "Day of Month"] = day;
  }
  if (resolved === "Weekly") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekday = days.find((day) => day.toLowerCase() === String(body.weekday || "").toLowerCase());
    if (!weekday) return badRequest(`A weekly bill needs a weekday: ${days.join(", ")}`);
    fields[env.AIRTABLE_BILLS_WEEKDAY_FIELD || "Weekday"] = weekday;
  }
  if (resolved === "Every 2 Weeks" || resolved === "One-time" || resolved === "Quarterly") {
    let anchor;
    try {
      anchor = normalizeDate(body.anchor ?? null);
    } catch (err) {
      return badRequest(err.message);
    }
    if (!anchor && resolved !== "Quarterly") {
      return badRequest(`A ${resolved.toLowerCase()} bill needs a date to count from`);
    }
    if (anchor) fields[env.AIRTABLE_BILLS_ANCHOR_FIELD || "Anchor or One-Time Date"] = anchor;
  }

  if (!env.AIRTABLE_BILLS_BASE_ID || !env.AIRTABLE_BILLS_TABLE) {
    throw new ConfigError("the recurring items table is not set");
  }
  const created = await airtable.createRecord(env, env.AIRTABLE_BILLS_BASE_ID, env.AIRTABLE_BILLS_TABLE, fields);
  return json({ ok: true, id: created.id, name, amount, frequency: resolved });
}

/**
 * POST /api/money/budgets/:id — retune a category's monthly budget.
 *
 * The starting numbers are Jan–Jul averages, so these are meant to be edited.
 * Still a money write, so it goes behind the same confirm as the rest and
 * returns the previous amount for undo.
 */
export async function handleSetBudget(request, env, recordId) {
  if (!validRecordId(recordId)) return badRequest("Bad budget id");
  const body = await request.json().catch(() => ({}));

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return badRequest("Enter an amount of zero or more");
  if (amount > 1000000) return badRequest("That looks like a typo — budgets cap at $1,000,000");

  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_BUDGETS_TABLE) {
    throw new ConfigError("the category budgets table is not set");
  }

  const baseId = env.AIRTABLE_MONEY_BASE_ID;
  const table = env.AIRTABLE_BUDGETS_TABLE;
  const amountField = env.AIRTABLE_BUDGET_AMOUNT_FIELD || "Monthly Budget";

  const before = await airtable.getRecord(env, baseId, table, recordId);
  const previousAmount = Number(before?.fields?.[amountField]) || 0;

  await airtable.updateRecord(env, baseId, table, recordId, { [amountField]: amount });
  return json({
    ok: true,
    amount,
    previousAmount,
    category: airtable.toText(before?.fields?.[env.AIRTABLE_BUDGET_CATEGORY_FIELD || "Category"]),
  });
}
