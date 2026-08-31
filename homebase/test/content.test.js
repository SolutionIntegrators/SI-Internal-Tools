// The content pipeline reads ClickUp rather than Airtable. These pin the two
// things that are easy to get wrong: how a dropdown custom field is read back,
// and what happens to the majority of this list, which has no due date.
import test from "node:test";
import assert from "node:assert/strict";

import { contentPipeline } from "../src/routes/tasks.js";
import { customField, dropdownOptionId } from "../src/services/clickup.js";

const TZ = "America/Chicago";
const CONTENT_TYPE = {
  id: "46c91d01-34b1-472e-8672-ce170233bcc3",
  name: "Content Type",
  type: "drop_down",
  type_config: {
    options: [
      { id: "2bbc20e2-6359-4a3b-8f97-112e4702e9e2", name: "Reel", orderindex: 2 },
      { id: "c73de4d1-114e-4a09-9555-98c2434b97f4", name: "Post", orderindex: 3 },
    ],
  },
};

const task = (name, { due = null, status = "to do", value } = {}) => ({
  id: name.toLowerCase().replace(/\W/g, ""),
  name,
  due_date: due,
  status: { status },
  custom_fields: [{ ...CONTENT_TYPE, value }],
});

test("a dropdown reads back by option id or by orderindex", () => {
  // ClickUp returns one or the other depending on the endpoint; both must work.
  assert.equal(customField(task("a", { value: "2bbc20e2-6359-4a3b-8f97-112e4702e9e2" }), "Content Type"), "Reel");
  assert.equal(customField(task("b", { value: 3 }), "Content Type"), "Post");
  assert.equal(customField(task("c", { value: "3" }), "Content Type"), "Post");
});

test("an unset or unknown custom field is empty, not a crash", () => {
  assert.equal(customField(task("d"), "Content Type"), "");
  assert.equal(customField(task("e", { value: "" }), "Content Type"), "");
  assert.equal(customField(task("f", { value: 2 }), "Nonexistent Field"), "");
  assert.equal(customField({ name: "g" }, "Content Type"), "");
});

test("dated content sorts first, and undated still makes the list", () => {
  // 18 of the 25 real tasks on this list have no date. Sorting on date alone
  // would drop every one of them off the card.
  const tasks = [
    task("No date A"),
    task("Later", { due: String(Date.parse("2026-09-01T12:00:00Z")) }),
    task("No date B"),
    task("Sooner", { due: String(Date.parse("2026-08-20T12:00:00Z")) }),
  ];
  const rows = contentPipeline(tasks, { tz: TZ });
  assert.deepEqual(rows.map((r) => r.title), ["Sooner", "Later", "No date A", "No date B"]);
  assert.equal(rows[0].dueDate, "2026-08-20");
  assert.equal(rows[2].dueDate, "");
});

test("the pipeline carries what the card and the calendar both need", () => {
  const [row] = contentPipeline(
    [task("W5 Carousel", { due: String(Date.parse("2026-08-21T12:00:00Z")), status: "ready for review", value: 2 })],
    { tz: TZ },
  );
  assert.deepEqual(row, {
    id: "w5carousel",
    title: "W5 Carousel",
    stage: "ready for review",
    platform: "Reel",
    dueDate: "2026-08-21",
  });
});

test("writing a dropdown resolves the option name to its id", () => {
  const fields = [CONTENT_TYPE];
  assert.deepEqual(dropdownOptionId({ fields }, "Content Type", "reel"), {
    fieldId: "46c91d01-34b1-472e-8672-ce170233bcc3",
    optionId: "2bbc20e2-6359-4a3b-8f97-112e4702e9e2",
  });
  assert.equal(dropdownOptionId({ fields }, "Content Type", "Podcast"), null);
  assert.equal(dropdownOptionId({ fields }, "Missing", "Reel"), null);
});
