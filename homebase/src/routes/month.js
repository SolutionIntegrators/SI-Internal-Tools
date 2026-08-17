// GET /api/dashboard/month?month=YYYY-MM
//
// Everything with a date, on one grid. The per-card endpoints answer narrow
// questions with narrow windows — the calendar is the next 8 days, bills are
// the next 7 — so this pulls its own wider windows rather than trying to reuse
// payloads that were never meant to cover a month.
//
// Five sources, each degrading on its own: a dead Google token should cost the
// calendar events, not the whole grid.
import { json, softly } from "../lib/http.js";
import { localDate, addDays } from "../lib/dates.js";
import { monthGrid, byDay, isValidMonth } from "../lib/month.js";
import * as clickup from "../services/clickup.js";
import * as google from "../services/google.js";
import * as airtable from "../services/airtable.js";
import { calendarConfigured } from "./calendar.js";
import { billsDueSoon } from "./money.js";

/** The project dates that mean a client is expecting something on that day. */
function milestoneFields(env) {
  const configured = env.AIRTABLE_PROJECT_MILESTONE_FIELDS;
  if (configured) {
    return configured
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((field) => ({ field, label: field.replace(/^[^\w]+\s*/, "") }));
  }
  return [
    { field: "2️⃣ Kickoff Call", label: "Kickoff Call" },
    { field: "5️⃣ Implementation", label: "Implementation" },
    { field: "6️⃣ Walkthrough Call", label: "Walkthrough" },
    { field: "Support End", label: "Support ends" },
  ];
}

export async function handleMonth(env, ctx, url) {
  const tz = env.TIMEZONE;
  const today = localDate(new Date(), tz);
  const requested = url?.searchParams?.get("month");
  const month = isValidMonth(requested) ? requested : today.slice(0, 7);
  const grid = monthGrid(month);
  const warnings = [];

  const [content, milestones, events, payments, bills] = await Promise.all([
    softly(warnings, "Content", fetchContent(env, tz, grid), { dated: [], unscheduled: [] }),
    softly(warnings, "Project milestones", fetchMilestones(env, grid), []),
    softly(warnings, "Calendar", fetchEvents(env, tz, grid), []),
    softly(warnings, "Upcoming payments", fetchPayments(env, grid), []),
    softly(warnings, "Bills", fetchBills(env, grid), []),
  ]);

  const payload = {
    ...grid,
    today,
    days: byDay([...content.dated, ...milestones, ...events, ...payments, ...bills]),
    unscheduled: content.unscheduled,
    // The create form offers these; an empty list just means no dropdown.
    contentTypes: (env.CLICKUP_CONTENT_TYPES || "Thread,Carousel,Reel,Post,Story,Email,Blog,YouTube")
      .split(",")
      .map((type) => type.trim())
      .filter(Boolean),
    canCreate: Boolean(env.CLICKUP_CONTENT_LIST_ID),
    warnings,
  };

  ctx.waitUntil(Promise.resolve());
  return json(payload);
}

/**
 * Content tasks split by whether they have a date. The undated ones are the
 * point of the rail — most of this list has no date, and they would otherwise
 * be invisible on a calendar.
 */
async function fetchContent(env, tz, grid) {
  if (!env.CLICKUP_CONTENT_LIST_ID) return { dated: [], unscheduled: [] };
  const tasks = await clickup.listTasks(env, env.CLICKUP_CONTENT_LIST_ID, {
    include_closed: false,
    subtasks: false,
  });

  const dated = [];
  const unscheduled = [];
  for (const task of tasks) {
    const due = clickup.dueMs(task);
    const base = {
      id: task.id,
      title: task.name || "Untitled",
      stage: task.status?.status || "",
      platform: clickup.customField(task, "Content Type"),
      url: task.url || "",
    };
    if (!due) {
      unscheduled.push(base);
      continue;
    }
    const date = localDate(new Date(due), tz);
    // Tasks outside this month still exist; they just aren't on this grid.
    if (date >= grid.gridStart && date <= grid.gridEnd) {
      dated.push({ ...base, kind: "content", date });
    }
  }
  return { dated, unscheduled };
}

async function fetchMilestones(env, grid) {
  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_PROJECTS_TABLE) return [];
  const nameField = env.AIRTABLE_PROJECT_NAME_FIELD || "Company Name";
  const records = await airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, env.AIRTABLE_PROJECTS_TABLE, {
    maxRecords: 100,
  });

  const items = [];
  for (const record of records) {
    const client = airtable.toText(record.fields?.[nameField]) || "Unnamed";
    for (const { field, label } of milestoneFields(env)) {
      const date = String(record.fields?.[field] || "").slice(0, 10);
      if (!date || date < grid.gridStart || date > grid.gridEnd) continue;
      items.push({ kind: "milestone", date, title: label, meta: client, id: `${record.id}:${field}` });
    }
  }
  return items;
}

async function fetchEvents(env, tz, grid) {
  if (!calendarConfigured(env)) return [];
  const events = await google.listEvents(env, {
    timeMin: new Date(`${grid.gridStart}T00:00:00Z`),
    // One day past the end so an event late on the last square is still caught
    // whatever the offset between the calendar's zone and UTC.
    timeMax: new Date(`${addDays(grid.gridEnd, 1)}T23:59:59Z`),
    maxResults: 250,
  });

  return events
    .map((event) => {
      const start = google.startsAt(event);
      if (!start) return null;
      const date = google.isAllDay(event)
        ? String(event.start.date).slice(0, 10)
        : localDate(start, tz);
      if (date < grid.gridStart || date > grid.gridEnd) return null;
      return {
        kind: "event",
        date,
        title: event.summary || "(no title)",
        meta: google.isAllDay(event) ? "all day" : shortClock(start, tz),
        id: event.id,
      };
    })
    .filter(Boolean);
}

function shortClock(date, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
}

async function fetchPayments(env, grid) {
  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_INVOICE_TABLE) return [];
  const dueField = env.AIRTABLE_INVOICE_DUE_FIELD || "Due Date";
  const statusField = env.AIRTABLE_INVOICE_STATUS_FIELD || "Status";
  const summaryField = env.AIRTABLE_INVOICE_SUMMARY_FIELD || "Summary";
  const amountField = env.AIRTABLE_INVOICE_AMOUNT_FIELD || "Payment Amount";
  const totalField = env.AIRTABLE_INVOICE_TOTAL_FIELD || "Invoice Total";

  const records = await airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, env.AIRTABLE_INVOICE_TABLE, {
    filterByFormula: airtable.dateRangeFormula(dueField, grid.gridStart, grid.gridEnd),
    maxRecords: 100,
  });

  return records
    .filter((record) => {
      const status = airtable.toText(record.fields?.[statusField]).toLowerCase();
      return !["paid", "project cancelled", "delete"].includes(status);
    })
    .map((record) => ({
      kind: "payment",
      date: String(record.fields?.[dueField] || "").slice(0, 10),
      title: airtable.toText(record.fields?.[summaryField]).split("|")[0].trim() || "Payment",
      meta: airtable.formatMoney(
        airtable.toAmount(record.fields?.[amountField]) || airtable.toAmount(record.fields?.[totalField]),
      ),
      id: record.id,
    }))
    .filter((item) => item.date);
}

/**
 * Bills are recurrence rules, so the whole grid is expanded at once rather than
 * the 7-day window the card uses. billsDueSoon already knows how to skip
 * occurrences settled by Paid Through.
 */
async function fetchBills(env, grid) {
  if (!env.AIRTABLE_BILLS_BASE_ID || !env.AIRTABLE_BILLS_TABLE) return [];
  const records = await airtable.listRecords(env, env.AIRTABLE_BILLS_BASE_ID, env.AIRTABLE_BILLS_TABLE, {
    maxRecords: 200,
  });

  const span = Math.round(
    (Date.parse(`${grid.gridEnd}T00:00:00Z`) - Date.parse(`${grid.gridStart}T00:00:00Z`)) / 86400000,
  );
  return billsDueSoon(records, { env, today: grid.gridStart, days: span, limit: 500 }).map((bill) => ({
    kind: "bill",
    date: bill.due,
    title: bill.name,
    meta: bill.amount,
    id: `${bill.id}:${bill.due}`,
    billId: bill.id,
    paidThrough: bill.paidThrough,
  }));
}
