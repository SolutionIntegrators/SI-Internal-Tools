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

test("adding a payment refuses an empty client, a bad amount, or a bad date", async () => {
  const { handleCreateInvoice } = await import("../src/routes/moneyEdits.js");
  for (const [body, pattern] of [
    [{ amount: 100, due: "2026-09-01" }, /who is the payment from/i],
    [{ client: "  ", amount: 100 }, /who is the payment from/i],
    [{ client: "Acme", amount: 0 }, /greater than zero/i],
    [{ client: "Acme", amount: "not a number" }, /greater than zero/i],
    [{ client: "Acme", amount: -50 }, /greater than zero/i],
    [{ client: "Acme", amount: 100, due: "01/09/2026" }, /YYYY-MM-DD/],
  ]) {
    const response = await handleCreateInvoice(post(body), env);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, pattern);
  }
});

test("a new bill must carry the anchor its frequency actually reads", async () => {
  const { handleCreateBill } = await import("../src/routes/moneyEdits.js");
  const base = { name: "Adobe", amount: 60 };

  const noFreq = await handleCreateBill(post(base), env);
  assert.equal(noFreq.status, 400);
  assert.match((await noFreq.json()).error, /Frequency must be one of/);

  // Monthly without a day would produce a rule that never fires.
  const monthlyNoDay = await handleCreateBill(post({ ...base, frequency: "Monthly" }), env);
  assert.equal(monthlyNoDay.status, 400);
  assert.match((await monthlyNoDay.json()).error, /day of the month/);

  const badDay = await handleCreateBill(post({ ...base, frequency: "Monthly", dayOfMonth: 32 }), env);
  assert.equal(badDay.status, 400);

  const weeklyNoDay = await handleCreateBill(post({ ...base, frequency: "Weekly" }), env);
  assert.equal(weeklyNoDay.status, 400);
  assert.match((await weeklyNoDay.json()).error, /weekday/);

  const onceNoDate = await handleCreateBill(post({ ...base, frequency: "One-time" }), env);
  assert.equal(onceNoDate.status, 400);
  assert.match((await onceNoDate.json()).error, /date to count from/);

  const noName = await handleCreateBill(post({ amount: 60, frequency: "Monthly", dayOfMonth: 1 }), env);
  assert.equal(noName.status, 400);
  assert.match((await noName.json()).error, /name/i);
});
