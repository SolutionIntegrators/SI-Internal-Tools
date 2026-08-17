// The money write helpers. These are the rules that decide whether a request
// ever reaches Airtable, so they are worth pinning down without a network.
import test from "node:test";
import assert from "node:assert/strict";

import {
  validRecordId,
  normalizeDate,
  resolveInvoiceStatus,
  allowedInvoiceStatuses,
  advancePaidThrough,
  isSettled,
} from "../src/lib/moneyEdits.js";
import { billsDueSoon } from "../src/routes/money.js";
import { handleInvoiceStatus, handleBillPaid } from "../src/routes/moneyEdits.js";

const env = {
  TIMEZONE: "America/Chicago",
  AIRTABLE_MONEY_BASE_ID: "appfVpfMqptf35xRa",
  AIRTABLE_INVOICE_TABLE: "Invoice Tracking",
  AIRTABLE_BILLS_BASE_ID: "appQeUH0Lb6i3lxTL",
  AIRTABLE_BILLS_TABLE: "Recurring Items",
  AIRTABLE_BILLS_PAID_THROUGH_FIELD: "Paid Through",
};

const post = (body) => new Request("https://x/", { method: "POST", body: JSON.stringify(body) });

test("only real Airtable record ids get past validation", () => {
  assert.ok(validRecordId("recDZdM98RcLYAOXD"));
  assert.ok(!validRecordId("recDZdM98RcLYAOX"), "too short");
  assert.ok(!validRecordId("../../admin"), "path traversal");
  assert.ok(!validRecordId("rec DZdM98RcLYAOX"), "whitespace");
  assert.ok(!validRecordId(""));
  assert.ok(!validRecordId(null));
});

test("dates are plain calendar dates or nothing", () => {
  assert.equal(normalizeDate("2026-08-20"), "2026-08-20");
  assert.equal(normalizeDate(""), null);
  assert.equal(normalizeDate(null), null);
  assert.throws(() => normalizeDate("08/20/2026"), /YYYY-MM-DD/);
  assert.throws(() => normalizeDate("2026-13-01"), /not a real date/);
});

test("the destructive invoice statuses cannot be set from the dashboard", () => {
  assert.equal(resolveInvoiceStatus(env, "paid"), "Paid");
  assert.equal(resolveInvoiceStatus(env, "In progress"), "In progress");
  assert.equal(resolveInvoiceStatus(env, "Delete"), null);
  assert.equal(resolveInvoiceStatus(env, "Project Cancelled"), null);
  assert.equal(resolveInvoiceStatus(env, ""), null);
  assert.ok(!allowedInvoiceStatuses(env).includes("Delete"));
});

test("marking a bill paid only ever moves the mark forward", () => {
  assert.equal(advancePaidThrough(null, "2026-08-20"), "2026-08-20");
  assert.equal(advancePaidThrough("2026-07-20", "2026-08-20"), "2026-08-20");
  // Checking off an occurrence older than the mark must not un-pay the newer one.
  assert.equal(advancePaidThrough("2026-08-20", "2026-07-20"), "2026-08-20");
  assert.throws(() => advancePaidThrough(null, null), /occurrence date/);
});

test("occurrences on or before the mark are settled", () => {
  assert.ok(isSettled("2026-08-20", "2026-08-20"));
  assert.ok(isSettled("2026-08-19", "2026-08-20"));
  assert.ok(!isSettled("2026-08-21", "2026-08-20"));
  assert.ok(!isSettled("2026-08-21", ""), "no mark means nothing is settled");
});

test("a paid bill drops off the card but its next occurrence does not", () => {
  const records = [
    {
      id: "recDZdM98RcLYAOXD",
      fields: {
        Name: "Adobe",
        Type: "Expense",
        Amount: 60,
        Active: true,
        Frequency: "Weekly",
        Weekday: "Thu",
        "Paid Through": "2026-08-20",
      },
    },
  ];
  // Thu 8/20 is settled; Thu 8/27 is inside the 7-day window and still owed.
  const due = billsDueSoon(records, { env, today: "2026-08-20" });
  assert.deepEqual(due.map((bill) => bill.due), ["2026-08-27"]);
  assert.equal(due[0].id, "recDZdM98RcLYAOXD");
  assert.equal(due[0].paidThrough, "2026-08-20");

  // With the mark cleared, both occurrences are owed again.
  records[0].fields["Paid Through"] = "";
  const all = billsDueSoon(records, { env, today: "2026-08-20" });
  assert.deepEqual(all.map((bill) => bill.due), ["2026-08-20", "2026-08-27"]);
});

test("bad ids and bad statuses are refused before Airtable is ever called", async () => {
  const bad = await handleInvoiceStatus(post({ status: "Paid" }), env, "not-a-record");
  assert.equal(bad.status, 400);

  const banned = await handleInvoiceStatus(post({ status: "Delete" }), env, "recDZdM98RcLYAOXD");
  assert.equal(banned.status, 400);
  assert.match((await banned.json()).error, /Status must be one of/);

  const noDate = await handleBillPaid(post({}), env, "recDZdM98RcLYAOXD");
  assert.equal(noDate.status, 400);
});

test("bills stay read-only when there is no column to record a payment in", async () => {
  const withoutField = { ...env, AIRTABLE_BILLS_PAID_THROUGH_FIELD: "" };
  await assert.rejects(
    () => handleBillPaid(post({ due: "2026-08-20" }), withoutField, "recDZdM98RcLYAOXD"),
    /nowhere to record a paid bill/,
  );
});
