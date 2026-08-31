// POST /api/tasks — create a content task.
//
// Narrow on purpose: the calendar's create form drops a task on the Content
// Management list and nowhere else. A general "create anywhere" endpoint would
// need a list picker and list-specific status and field handling, and the
// dashboard has no use for that yet.
import { json, badRequest, ConfigError } from "../lib/http.js";
import * as clickup from "../services/clickup.js";
import { dueDateToMs } from "../lib/taskEdits.js";

const MAX_TITLE = 200;

export async function handleCreateTask(request, env) {
  if (!env.CLICKUP_CONTENT_LIST_ID) {
    throw new ConfigError("CLICKUP_CONTENT_LIST_ID is not set, so there is no list to create in");
  }

  const body = await request.json().catch(() => ({}));

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return badRequest("A title is required");
  if (title.length > MAX_TITLE) return badRequest(`Titles are capped at ${MAX_TITLE} characters`);

  let dueMs;
  try {
    dueMs = dueDateToMs(body.due || null);
  } catch (err) {
    return badRequest(err.message);
  }

  const listId = env.CLICKUP_CONTENT_LIST_ID;
  const payload = { name: title };
  if (dueMs) {
    payload.due_date = dueMs;
    payload.due_date_time = false;
  }

  // The content type is optional, and an unknown one is dropped rather than
  // failing the whole create — a task with no type beats no task.
  if (body.contentType) {
    const fields = await clickup.listFields(env, listId);
    const resolved = clickup.dropdownOptionId({ fields }, "Content Type", body.contentType);
    if (resolved) payload.custom_fields = [{ id: resolved.fieldId, value: resolved.optionId }];
  }

  const created = await clickup.createTask(env, listId, payload);
  return json({
    ok: true,
    task: {
      id: created.id,
      title: created.name || title,
      url: created.url || "",
      stage: created.status?.status || "",
      dueDate: body.due || "",
      platform: body.contentType || "",
    },
  });
}
