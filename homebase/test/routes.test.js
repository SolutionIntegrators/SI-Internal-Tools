// The filter tests cover the rules; these cover the handlers themselves.
// A missing import inside a route only throws when that route actually runs,
// which unit tests over pure functions will never notice — that is how
// "localDate is not defined" reached a deployed dashboard.
//
// With no credentials every upstream call fails at its requireVar check before
// any network access, so these run offline and finish in milliseconds.
import test from "node:test";
import assert from "node:assert/strict";

import { handleTasks } from "../src/routes/tasks.js";
import { handleCalendar } from "../src/routes/calendar.js";
import { handleMoney } from "../src/routes/money.js";

// Mirrors the non-secret vars in wrangler.toml. Without the base ids the
// fetches short-circuit before ever reaching a credential check, which makes
// the test pass for the wrong reason.
const env = {
  TIMEZONE: "America/Chicago",
  REVENUE_GOAL: "5000",
  CLICKUP_TEAM_ID: "8619174",
  AIRTABLE_MONEY_BASE_ID: "appfVpfMqptf35xRa",
  AIRTABLE_INCOME_TABLE: "Income Tracking",
  AIRTABLE_INVOICE_TABLE: "Invoice Tracking",
  AIRTABLE_PROJECTS_TABLE: "ALL Active Projects",
  AIRTABLE_BILLS_BASE_ID: "appQeUH0Lb6i3lxTL",
  AIRTABLE_BILLS_TABLE: "Recurring Items",
  AIRTABLE_GOALS_TABLE: "Weekly Revenue Goals",
  AIRTABLE_CONTENT_BASE_ID: "appzyaY40KNIy3n4t",
  AIRTABLE_CONTENT_TABLE: "Social Media Management",
};
const ctx = { waitUntil() {} };

for (const [name, handler, expectedKeys] of [
  ["tasks", handleTasks, ["myTasksSoon", "readyForReview", "supportTickets", "clientProjects"]],
  ["calendar", handleCalendar, ["nextCalls", "calendarToday", "calendarWeek"]],
  ["money", handleMoney, ["revenue", "upcomingPayments", "upcomingBills", "contentPipeline"]],
]) {
  test(`${name} endpoint answers with its full shape when every source is unconfigured`, async () => {
    const response = await handler(env, ctx);
    assert.equal(response.status, 200, `${name} should degrade, not fail`);
    const body = await response.json();
    for (const key of expectedKeys) {
      assert.ok(key in body, `${name} payload is missing ${key}`);
    }
    assert.ok(Array.isArray(body.warnings), `${name} should report which sources failed`);
  });
}

test("a dead source is named in warnings rather than swallowed", async () => {
  const body = await (await handleMoney(env, ctx)).json();
  assert.ok(
    body.warnings.some((warning) => warning.includes("AIRTABLE_TOKEN")),
    "the missing credential should be named",
  );
});

test("the calendar is absent, not broken, when it is switched off", async () => {
  const body = await (await handleCalendar(env, ctx)).json();
  assert.equal(body.calendarConfigured, false);
  assert.deepEqual(body.warnings, []);
});

test("CALENDAR_ENABLED=false wins even if Google credentials are present", async () => {
  const withGoogle = {
    ...env,
    CALENDAR_ENABLED: "false",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "token",
  };
  const body = await (await handleCalendar(withGoogle, ctx)).json();
  assert.equal(body.calendarConfigured, false);
});
