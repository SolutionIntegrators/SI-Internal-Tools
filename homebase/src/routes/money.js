// GET /api/dashboard/money — Airtable: the money hub, the bills base, and
// the content planning base.
import { json, softly } from "../lib/http.js";
import { localDate, startOfWeek, addDays } from "../lib/dates.js";
import * as airtable from "../services/airtable.js";
import { selectBillsDueSoon, sumCollectedThisWeek, revenueNote } from "../lib/filters.js";
import { readSnapshot, writeSnapshot } from "../lib/cache.js";

function paidValues(env) {
  return (env.AIRTABLE_MONEY_PAID_VALUES || "Paid,Received,Won,Collected")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function handleMoney(env, ctx) {
  const tz = env.TIMEZONE;
  const now = new Date();
  const today = localDate(now, tz);
  const weekStart = startOfWeek(now, tz);
  const goal = Number(env.REVENUE_GOAL || 7500);
  const warnings = [];

  const moneyBase = env.AIRTABLE_MONEY_BASE_ID;
  const moneyTable = env.AIRTABLE_MONEY_TABLE;
  const dateField = env.AIRTABLE_MONEY_DATE_FIELD || "Date";
  const amountField = env.AIRTABLE_MONEY_AMOUNT_FIELD || "Amount";
  const statusField = env.AIRTABLE_MONEY_STATUS_FIELD || "";
  const clientField = env.AIRTABLE_MONEY_CLIENT_FIELD || "Client";
  const expectedField = env.AIRTABLE_MONEY_EXPECTED_FIELD || dateField;

  const [collectedRecords, expectedRecords, billRecords, contentRecords] = await Promise.all([
    moneyBase
      ? softly(
          warnings,
          "Airtable revenue",
          airtable.listRecords(env, moneyBase, moneyTable, {
            filterByFormula: airtable.dateRangeFormula(dateField, weekStart, today),
            maxRecords: 100,
          }),
          [],
        )
      : Promise.resolve([]),
    moneyBase
      ? softly(
          warnings,
          "Airtable upcoming payments",
          airtable.listRecords(env, moneyBase, moneyTable, {
            filterByFormula: airtable.dateRangeFormula(expectedField, addDays(today, 1), addDays(today, 45)),
            sort: [{ field: expectedField, direction: "asc" }],
            maxRecords: 20,
          }),
          [],
        )
      : Promise.resolve([]),
    env.AIRTABLE_BILLS_BASE_ID
      ? softly(
          warnings,
          "Airtable bills",
          airtable.listRecords(env, env.AIRTABLE_BILLS_BASE_ID, env.AIRTABLE_BILLS_TABLE, {
            maxRecords: 100,
          }),
          [],
        )
      : Promise.resolve([]),
    env.AIRTABLE_CONTENT_BASE_ID
      ? softly(
          warnings,
          "Airtable content",
          airtable.listRecords(env, env.AIRTABLE_CONTENT_BASE_ID, env.AIRTABLE_CONTENT_TABLE, {
            maxRecords: 25,
          }),
          [],
        )
      : Promise.resolve([]),
  ]);

  const current = sumCollectedThisWeek(collectedRecords, {
    dateField,
    amountField,
    statusField,
    paidValues: paidValues(env),
    weekStart,
    today,
    toAmount: airtable.toAmount,
    toText: airtable.toText,
  });

  const billDueField = env.AIRTABLE_BILLS_DUE_FIELD || "Due";
  const billNameField = env.AIRTABLE_BILLS_NAME_FIELD || "Name";
  const billAmountField = env.AIRTABLE_BILLS_AMOUNT_FIELD || "Amount";

  const payload = {
    revenue: { goal, current: Math.round(current), note: revenueNote(current, goal) },
    upcomingPayments: expectedRecords.slice(0, 5).map((record) => ({
      client: airtable.toText(record.fields?.[clientField]) || "Unnamed",
      amount: airtable.formatMoney(airtable.toAmount(record.fields?.[amountField])),
      expected: String(record.fields?.[expectedField] || "").slice(0, 10),
    })),
    upcomingBills: selectBillsDueSoon(billRecords, { dueField: billDueField, now: now.getTime(), tz }).map(
      ({ record, due }) => ({
        name: airtable.toText(record.fields?.[billNameField]) || "Unnamed",
        amount: airtable.formatMoney(airtable.toAmount(record.fields?.[billAmountField])),
        due,
      }),
    ),
    contentPipeline: contentRecords.slice(0, 5).map((record) => ({
      title: airtable.toText(record.fields?.[env.AIRTABLE_CONTENT_TITLE_FIELD || "Title"]) || "Untitled",
      stage: normalizeStage(airtable.toText(record.fields?.[env.AIRTABLE_CONTENT_STAGE_FIELD || "Stage"])),
      platform: airtable.toText(record.fields?.[env.AIRTABLE_CONTENT_PLATFORM_FIELD || "Platform"]),
    })),
    warnings,
  };

  ctx.waitUntil(writeSnapshot(env, "money", payload));
  return json(payload);
}

/** The content card only renders four stages. */
function normalizeStage(value) {
  const text = value.toLowerCase();
  if (text.includes("post")) return "posted";
  if (text.includes("schedul")) return "scheduled";
  if (text.includes("draft") || text.includes("writ")) return "drafted";
  return "idea";
}

export async function cachedMoney(env) {
  return readSnapshot(env, "money");
}
