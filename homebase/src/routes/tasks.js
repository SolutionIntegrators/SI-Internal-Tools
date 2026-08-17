// GET /api/dashboard/tasks — ClickUp, plus Supabase for client projects.
import { json, softly, requireVar } from "../lib/http.js";
import { relativeDay, localDate } from "../lib/dates.js";
import * as clickup from "../services/clickup.js";
import * as supabase from "../services/supabase.js";
import * as airtable from "../services/airtable.js";
import {
  selectDueSoon,
  selectReadyForReview,
  selectTickets,
  isClosed,
} from "../lib/filters.js";
import { readSnapshot, writeSnapshot } from "../lib/cache.js";

function idList(value) {
  return (value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Folder ids and list ids, as ClickUp's team task endpoint wants them. */
function scopeParams(folderIds, listIds) {
  const folders = idList(folderIds);
  const lists = idList(listIds);
  const params = {};
  if (folders.length) params["project_ids[]"] = folders;
  if (lists.length) params["list_ids[]"] = lists;
  return params;
}

export async function handleTasks(env, ctx) {
  const tz = env.TIMEZONE;
  const now = Date.now();
  const warnings = [];

  const teamId = requireVar(env, "CLICKUP_TEAM_ID");
  // Scope is set by folder where possible: Client Projects gains a list per
  // engagement, so a list-id allowlist would drop every new client until
  // someone remembered to edit the config. ClickUp calls folder ids
  // "project_ids" on the team task endpoint.
  const workScope = scopeParams(env.CLICKUP_WORK_FOLDER_IDS, env.CLICKUP_WORK_LIST_IDS);
  const supportScope = scopeParams(env.CLICKUP_SUPPORT_FOLDER_IDS, env.CLICKUP_SUPPORT_LIST_IDS);

  const [user, workTasks, ticketTasks, projectRows, contentTasks] = await Promise.all([
    softly(warnings, "ClickUp user", clickup.currentUser(env), null),
    softly(
      warnings,
      "ClickUp tasks",
      clickup.teamTasks(env, teamId, { include_closed: false, subtasks: true, ...workScope }),
      [],
    ),
    Object.keys(supportScope).length
      ? softly(
          warnings,
          "ClickUp tickets",
          clickup.teamTasks(env, teamId, { include_closed: false, ...supportScope }),
          [],
        )
      : Promise.resolve([]),
    softly(warnings, "Client projects", fetchProjects(env), null),
    softly(warnings, "Content", fetchContentTasks(env), []),
  ]);

  const assigneeId = env.CLICKUP_USER_ID || user?.id;
  const tickets = selectTickets(ticketTasks, { now, env });

  const payload = {
    // id and status ride along so the page can complete or reschedule a task,
    // and dueDate is the raw value the date control needs.
    myTasksSoon: selectDueSoon(workTasks, { userId: assigneeId, now, env }).map((task) => ({
      id: task.id,
      title: task.name,
      client: clickup.clientOf(task),
      due: relativeDay(new Date(clickup.dueMs(task)), now, tz),
      dueDate: localDate(new Date(clickup.dueMs(task)), tz),
      status: task.status?.status || null,
    })),
    readyForReview: selectReadyForReview(workTasks, { env }).map((task) => ({
      id: task.id,
      title: task.name,
      client: clickup.clientOf(task),
      dueDate: clickup.dueMs(task) ? localDate(new Date(clickup.dueMs(task)), tz) : "",
      status: task.status?.status || null,
    })),
    supportTickets: {
      openCount: tickets.openCount,
      overdue: tickets.overdue.map((ticket) => ({
        title: ticket.name,
        client: clickup.clientOf(ticket),
        daysOpen: Math.floor((now - clickup.createdMs(ticket)) / 86400000),
      })),
    },
    clientProjects: clientProjects({ projectRows, workTasks, env, today: localDate(new Date(now), tz) }),
    contentPipeline: contentPipeline(contentTasks, { tz }),
    warnings,
  };

  ctx.waitUntil(writeSnapshot(env, "tasks", payload));
  return json(payload);
}

/**
 * Content lives in the ClickUp Content Management list, which is where the work
 * actually happens — the Airtable table it used to read was downstream of this
 * and only received items once they hit "Send to Airtable", so the dashboard
 * was showing the tail of the pipeline rather than the pipeline.
 */
async function fetchContentTasks(env) {
  if (!env.CLICKUP_CONTENT_LIST_ID) return [];
  return clickup.listTasks(env, env.CLICKUP_CONTENT_LIST_ID, {
    include_closed: false,
    subtasks: false,
  });
}

/**
 * Dated items first, soonest first, then the undated backlog. Sorting purely by
 * date would bury everything without one, and most of this list has no date.
 */
export function contentPipeline(tasks, { tz, limit = 5 }) {
  const shaped = tasks.map((task) => {
    const due = clickup.dueMs(task);
    return {
      id: task.id,
      title: task.name || "Untitled",
      stage: task.status?.status || "",
      platform: clickup.customField(task, "Content Type"),
      dueDate: due ? localDate(new Date(due), tz) : "",
    };
  });

  return shaped
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    })
    .slice(0, limit);
}

/**
 * Projects come from Airtable's ALL Active Projects table, which is where the
 * real client roster lives. Supabase is an optional second source for the
 * portal, and ClickUp's folder structure is the last resort.
 */
async function fetchProjects(env) {
  if (env.AIRTABLE_MONEY_BASE_ID && env.AIRTABLE_PROJECTS_TABLE) {
    const field = projectFields(env);
    const records = await airtable.listRecords(env, env.AIRTABLE_MONEY_BASE_ID, env.AIRTABLE_PROJECTS_TABLE, {
      maxRecords: 50,
    });
    return records.map((record) => ({ source: "airtable", fields: record.fields || {}, field }));
  }
  if (env.SUPABASE_URL && env.SUPABASE_PROJECTS_TABLE) {
    const rows = await supabase.selectRows(env, env.SUPABASE_PROJECTS_TABLE, { limit: 25 });
    return rows.map((row) => ({ source: "supabase", row }));
  }
  return null;
}

function projectFields(env) {
  return {
    name: env.AIRTABLE_PROJECT_NAME_FIELD || "Company Name",
    status: env.AIRTABLE_PROJECT_STATUS_FIELD || "Project Status",
    service: env.AIRTABLE_PROJECT_SERVICE_FIELD || "Service",
    implementation: env.AIRTABLE_PROJECT_IMPLEMENTATION_FIELD || "5️⃣ Implementation",
    supportEnd: env.AIRTABLE_PROJECT_SUPPORT_END_FIELD || "Support End",
    ongoingValue: env.AIRTABLE_PROJECT_ONGOING_VALUE || "Ongoing Support",
  };
}

function clientProjects({ projectRows, workTasks, env, today }) {
  if (projectRows?.length) {
    return projectRows
      .slice(0, 5)
      .map((entry) =>
        entry.source === "airtable" ? airtableProject(entry, today) : supabaseProject(entry.row, env),
      );
  }

  const byFolder = new Map();
  for (const task of workTasks) {
    if (isClosed(task, env)) continue;
    const name = clickup.clientOf(task);
    if (!name) continue;
    const entry = byFolder.get(name) || { name, open: 0, latestStatus: "" };
    entry.open += 1;
    entry.latestStatus = task.status?.status || entry.latestStatus;
    byFolder.set(name, entry);
  }
  return [...byFolder.values()]
    .sort((a, b) => b.open - a.open)
    .slice(0, 5)
    .map((entry) => ({
      name: entry.name,
      phase: entry.latestStatus,
      status: "on_track",
      note: `${entry.open} open task${entry.open === 1 ? "" : "s"}`,
    }));
}

/**
 * The pill states are derived from dates rather than from Project Status,
 * which only ever says where a project is, never whether it is in trouble:
 * an implementation date that has passed while the project is still being
 * built needs attention, and a project past its support end date is done and
 * should be closed out.
 */
export function projectHealth({ status, implementation, supportEnd, today, ongoingValue }) {
  const ongoing = status.toLowerCase().includes(ongoingValue.toLowerCase());
  if (supportEnd && supportEnd < today && !ongoing) return "stalled";
  if (implementation && implementation < today && !ongoing) return "needs_attention";
  return "on_track";
}

function airtableProject({ fields, field }, today) {
  const status = airtable.toText(fields[field.status]);
  const service = airtable.toText(fields[field.service]);
  const implementation = String(fields[field.implementation] || "").slice(0, 10);
  const supportEnd = String(fields[field.supportEnd] || "").slice(0, 10);
  return {
    name: airtable.toText(fields[field.name]) || "Unnamed",
    phase: service,
    status: projectHealth({
      status,
      implementation,
      supportEnd,
      today,
      ongoingValue: field.ongoingValue,
    }),
    // Emoji in the Airtable status would collide with the card's own pill.
    note: status.replace(/[^\x00-\x7F]/g, "").trim(),
  };
}

function supabaseProject(row, env) {
  const map = {
    name: env.SUPABASE_PROJECT_NAME_FIELD || "name",
    phase: env.SUPABASE_PROJECT_PHASE_FIELD || "phase",
    status: env.SUPABASE_PROJECT_STATUS_FIELD || "status",
    note: env.SUPABASE_PROJECT_NOTE_FIELD || "note",
  };
  return {
    name: String(row[map.name] ?? "Untitled"),
    phase: String(row[map.phase] ?? ""),
    status: normalizeStatus(row[map.status]),
    note: String(row[map.note] ?? "").slice(0, 60),
  };
}

/** The dashboard pills only understand three states. */
function normalizeStatus(value) {
  const text = String(value ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["needs_attention", "at_risk", "blocked", "attention"].includes(text)) return "needs_attention";
  if (["stalled", "paused", "on_hold", "waiting"].includes(text)) return "stalled";
  return "on_track";
}

export async function cachedTasks(env) {
  return readSnapshot(env, "tasks");
}
