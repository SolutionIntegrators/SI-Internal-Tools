// ClickUp API v2, personal token. Docs: https://developer.clickup.com/reference
import { fetchJson, requireVar } from "../lib/http.js";

const BASE = "https://api.clickup.com/api/v2";

function headers(env) {
  return { Authorization: requireVar(env, "CLICKUP_TOKEN") };
}

/** The token's own user. Used to filter "assigned to Ashley" without hardcoding an id. */
export async function currentUser(env) {
  const data = await fetchJson("ClickUp", `${BASE}/user`, { headers: headers(env) });
  return data.user;
}

export async function teams(env) {
  const data = await fetchJson("ClickUp", `${BASE}/team`, { headers: headers(env) });
  return data.teams || [];
}

export async function spaces(env, teamId) {
  const data = await fetchJson("ClickUp", `${BASE}/team/${teamId}/space?archived=false`, {
    headers: headers(env),
  });
  return data.spaces || [];
}

export async function listsInSpace(env, spaceId) {
  const [folderless, folders] = await Promise.all([
    fetchJson("ClickUp", `${BASE}/space/${spaceId}/list?archived=false`, { headers: headers(env) }),
    fetchJson("ClickUp", `${BASE}/space/${spaceId}/folder?archived=false`, { headers: headers(env) }),
  ]);
  const lists = [...(folderless.list || [])];
  for (const folder of folders.folders || []) {
    for (const list of folder.lists || []) lists.push({ ...list, folder: { name: folder.name } });
  }
  return lists;
}

/**
 * Filtered team tasks. `params` is passed through to ClickUp — the useful keys
 * are assignees[], statuses[], list_ids[], due_date_lt, due_date_gt,
 * include_closed, order_by, subtasks.
 */
export async function teamTasks(env, teamId, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) query.append(key, String(item));
    else query.append(key, String(value));
  }
  const data = await fetchJson("ClickUp", `${BASE}/team/${teamId}/task?${query}`, {
    headers: headers(env),
  });
  return data.tasks || [];
}

/** Free-text search across the workspace, for the chat panel. */
export async function searchTasks(env, teamId, query, limit = 15) {
  const tasks = await teamTasks(env, teamId, {
    include_closed: true,
    subtasks: true,
    order_by: "updated",
    reverse: true,
  });
  const needle = query.toLowerCase();
  return tasks
    .filter((task) => {
      const haystack = [task.name, task.text_content, task.list?.name, task.folder?.name, task.status?.status]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    })
    .slice(0, limit);
}

/** The client a task belongs to, as far as ClickUp's hierarchy can tell us. */
export function clientOf(task) {
  return task.folder?.name && task.folder.name !== "hidden"
    ? task.folder.name
    : task.list?.name || "";
}

export function statusName(task) {
  return (task.status?.status || "").toLowerCase();
}

/** ClickUp epoch-ms strings, or null when a task has no date set. */
export function dueMs(task) {
  return task.due_date ? Number(task.due_date) : null;
}

export function createdMs(task) {
  return task.date_created ? Number(task.date_created) : null;
}

/** Every task on one list, with its custom fields. Used by the content pipeline. */
export async function listTasks(env, listId, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) query.append(key, String(item));
    else query.append(key, String(value));
  }
  const data = await fetchJson(
    "ClickUp",
    `${BASE}/list/${encodeURIComponent(listId)}/task?${query}`,
    { headers: headers(env) },
  );
  return data.tasks || [];
}

/**
 * A custom field's display value by field name. ClickUp is inconsistent about
 * dropdowns: sometimes `value` is the option's uuid, sometimes its orderindex.
 * Both are resolved back to the option name here so callers get a plain string.
 */
export function customField(task, fieldName) {
  const field = (task.custom_fields || []).find(
    (candidate) => String(candidate.name).toLowerCase() === String(fieldName).toLowerCase(),
  );
  if (!field || field.value === undefined || field.value === null || field.value === "") return "";

  const options = field.type_config?.options || [];
  if (options.length) {
    const match =
      options.find((option) => option.id === field.value) ||
      options.find((option) => option.orderindex === field.value) ||
      options.find((option) => String(option.orderindex) === String(field.value));
    if (match) return match.name || match.label || "";
  }
  return typeof field.value === "object" ? "" : String(field.value);
}

/** The option id a dropdown wants when writing. Null when the name is unknown. */
export function dropdownOptionId(list, fieldName, optionName) {
  const field = (list.fields || list.custom_fields || []).find(
    (candidate) => String(candidate.name).toLowerCase() === String(fieldName).toLowerCase(),
  );
  const option = (field?.type_config?.options || []).find(
    (candidate) => String(candidate.name).toLowerCase() === String(optionName).toLowerCase(),
  );
  return option ? { fieldId: field.id, optionId: option.id } : null;
}

/** Compact shape for the chat tool result — full task JSON is far too large. */
export function summarize(task) {
  return {
    name: task.name,
    status: task.status?.status || null,
    client: clientOf(task),
    list: task.list?.name || null,
    due: task.due_date ? new Date(Number(task.due_date)).toISOString() : null,
    assignees: (task.assignees || []).map((a) => a.username),
    url: task.url,
  };
}

// ---------- Writes ----------
// The dashboard can complete a task, move its due date, and create a content
// task. Support tickets stay read-only — those are client-facing.

export async function getTask(env, taskId) {
  return fetchJson("ClickUp", `${BASE}/task/${encodeURIComponent(taskId)}`, { headers: headers(env) });
}

/** A list's own status set. Statuses are per-list in ClickUp, not global. */
export async function getList(env, listId) {
  return fetchJson("ClickUp", `${BASE}/list/${encodeURIComponent(listId)}`, { headers: headers(env) });
}

export async function updateTask(env, taskId, body) {
  return fetchJson("ClickUp", `${BASE}/task/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    headers: { ...headers(env), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A list's custom field definitions, needed to resolve a dropdown name to its id. */
export async function listFields(env, listId) {
  const data = await fetchJson("ClickUp", `${BASE}/list/${encodeURIComponent(listId)}/field`, {
    headers: headers(env),
  });
  return data.fields || [];
}

export async function createTask(env, listId, body) {
  return fetchJson("ClickUp", `${BASE}/list/${encodeURIComponent(listId)}/task`, {
    method: "POST",
    headers: { ...headers(env), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
