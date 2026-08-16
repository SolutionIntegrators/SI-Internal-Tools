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
