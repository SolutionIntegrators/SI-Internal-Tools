// The one shared source of ALL Active Projects' field names, and the write
// endpoint built on it.
import test from "node:test";
import assert from "node:assert/strict";

import { projectFields, milestoneList, MILESTONE_KEYS } from "../src/lib/projectFields.js";
import { handleSetMilestone } from "../src/routes/projectEdits.js";

const env = { AIRTABLE_MONEY_BASE_ID: "appfVpfMqptf35xRa", AIRTABLE_PROJECTS_TABLE: "ALL Active Projects" };
const post = (body) => new Request("https://x/", { method: "POST", body: JSON.stringify(body) });

test("milestoneList's fields trace back to projectFields, in occurrence order", () => {
  const fields = projectFields(env);
  const list = milestoneList(env);
  assert.deepEqual(list.map((m) => m.key), MILESTONE_KEYS);
  assert.deepEqual(list.map((m) => m.key), ["kickoff", "implementation", "walkthrough", "supportEnd"]);
  for (const { key, field } of list) assert.equal(field, fields[key], key);
});

test("a custom field name overrides the default for both readers", () => {
  const custom = { ...env, AIRTABLE_PROJECT_KICKOFF_FIELD: "Kickoff Date" };
  assert.equal(milestoneList(custom).find((m) => m.key === "kickoff").field, "Kickoff Date");
});

test("setting a milestone rejects an unknown key or a missing date before touching Airtable", async () => {
  const badKey = await handleSetMilestone(post({ key: "invented", date: "2026-09-01" }), env, "rec1Wk3YRvfZxaV1n");
  assert.equal(badKey.status, 400);
  assert.match((await badKey.json()).error, /key must be one of/);

  const noDate = await handleSetMilestone(post({ key: "kickoff" }), env, "rec1Wk3YRvfZxaV1n");
  assert.equal(noDate.status, 400);
  assert.match((await noDate.json()).error, /not cleared/);

  const badId = await handleSetMilestone(post({ key: "kickoff", date: "2026-09-01" }), env, "not-a-record");
  assert.equal(badId.status, 400);

  const badDate = await handleSetMilestone(post({ key: "kickoff", date: "09/01/2026" }), env, "rec1Wk3YRvfZxaV1n");
  assert.equal(badDate.status, 400);
  assert.match((await badDate.json()).error, /YYYY-MM-DD/);
});
