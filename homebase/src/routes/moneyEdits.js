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
