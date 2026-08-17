// POST /api/tasks/:id/complete  — mark done, returning the prior status so the
//                                 page can offer an undo
// POST /api/tasks/:id/status    — set an explicit status (what undo calls)
// POST /api/tasks/:id/due       — move or clear the due date
//
// Deliberately narrow. Support tickets, Airtable money, and the content
// pipeline stay read-only, so a stray tap can't touch a client's ticket or an
// invoice.

import { json, badRequest, UpstreamError } from "../lib/http.js";
import * as clickup from "../services/clickup.js";
import { pickClosedStatus, dueDateToMs, validTaskId } from "../lib/taskEdits.js";

export async function handleComplete(env, taskId) {
  if (!validTaskId(taskId)) return badRequest("Bad task id");

  const task = await clickup.getTask(env, taskId);
  const previousStatus = task.status?.status || null;
  const listId = task.list?.id;
  if (!listId) throw new UpstreamError("ClickUp", "that task has no list, so its statuses can't be read");

  const list = await clickup.getList(env, listId);
  const closed = pickClosedStatus(list.statuses, env);
  if (!closed) {
    throw new UpstreamError("ClickUp", `no done status exists on the list "${list.name || listId}"`);
  }

  await clickup.updateTask(env, taskId, { status: closed });
  return json({ ok: true, status: closed, previousStatus });
}

export async function handleSetStatus(request, env, taskId) {
  if (!validTaskId(taskId)) return badRequest("Bad task id");
  const body = await request.json().catch(() => ({}));
  if (!body.status || typeof body.status !== "string") return badRequest("Expected a status");

  await clickup.updateTask(env, taskId, { status: body.status });
  return json({ ok: true, status: body.status });
}

export async function handleSetDue(request, env, taskId) {
  if (!validTaskId(taskId)) return badRequest("Bad task id");
  const body = await request.json().catch(() => ({}));

  let dueMs;
  try {
    dueMs = dueDateToMs(body.due || null);
  } catch (err) {
    return badRequest(err.message);
  }

  // A null due_date clears the date; due_date_time false keeps it a plain date
  // rather than a timed deadline.
  await clickup.updateTask(env, taskId, { due_date: dueMs, due_date_time: false });
  return json({ ok: true, due: body.due || null });
}
