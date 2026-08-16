// GET /api/dashboard/tasks — ClickUp, plus Supabase for client projects.
import { json, softly, requireVar } from "../lib/http.js";
import { relativeDay } from "../lib/dates.js";
import * as clickup from "../services/clickup.js";
import * as supabase from "../services/supabase.js";
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

export async function handleTasks(env, ctx) {
  const tz = env.TIMEZONE;
  const now = Date.now();
  const warnings = [];

  const teamId = requireVar(env, "CLICKUP_TEAM_ID");
  const supportListIds = idList(env.CLICKUP_SUPPORT_LIST_IDS);
  const workListIds = idList(env.CLICKUP_WORK_LIST_IDS);

  const [user, workTasks, ticketTasks, projectRows] = await Promise.all([
    softly(warnings, "ClickUp user", clickup.currentUser(env), null),
    softly(
      warnings,
      "ClickUp tasks",
      clickup.teamTasks(env, teamId, {
        include_closed: false,
        subtasks: true,
        "list_ids[]": workListIds.length ? workListIds : undefined,
      }),
      [],
    ),
    supportListIds.length
      ? softly(
          warnings,
          "ClickUp tickets",
          clickup.teamTasks(env, teamId, { include_closed: false, "list_ids[]": supportListIds }),
          [],
        )
      : Promise.resolve([]),
    env.SUPABASE_URL && env.SUPABASE_PROJECTS_TABLE
      ? softly(
          warnings,
          "Supabase projects",
          supabase.selectRows(env, env.SUPABASE_PROJECTS_TABLE, { limit: 25 }),
          [],
        )
      : Promise.resolve(null),
  ]);

  const assigneeId = env.CLICKUP_USER_ID || user?.id;
  const tickets = selectTickets(ticketTasks, { now, env });

  const payload = {
    myTasksSoon: selectDueSoon(workTasks, { userId: assigneeId, now, env }).map((task) => ({
      title: task.name,
      client: clickup.clientOf(task),
      due: relativeDay(new Date(clickup.dueMs(task)), now, tz),
    })),
    readyForReview: selectReadyForReview(workTasks, { env }).map((task) => ({
      title: task.name,
      client: clickup.clientOf(task),
    })),
    supportTickets: {
      openCount: tickets.openCount,
      overdue: tickets.overdue.map((ticket) => ({
        title: ticket.name,
        client: clickup.clientOf(ticket),
        daysOpen: Math.floor((now - clickup.createdMs(ticket)) / 86400000),
      })),
    },
    clientProjects: clientProjects({ projectRows, workTasks, env }),
    warnings,
  };

  ctx.waitUntil(writeSnapshot(env, "tasks", payload));
  return json(payload);
}

/**
 * Client projects come from the Supabase portal when it is configured, since
 * that is the customer-facing source of truth. Without it, ClickUp's folder
 * structure is the next best thing: one project per folder with active work.
 */
function clientProjects({ projectRows, workTasks, env }) {
  if (projectRows?.length) {
    const map = fieldMap(env);
    return projectRows.slice(0, 5).map((row) => ({
      name: String(row[map.name] ?? "Untitled"),
      phase: String(row[map.phase] ?? ""),
      status: normalizeStatus(row[map.status]),
      note: String(row[map.note] ?? "").slice(0, 60),
    }));
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

function fieldMap(env) {
  return {
    name: env.SUPABASE_PROJECT_NAME_FIELD || "name",
    phase: env.SUPABASE_PROJECT_PHASE_FIELD || "phase",
    status: env.SUPABASE_PROJECT_STATUS_FIELD || "status",
    note: env.SUPABASE_PROJECT_NOTE_FIELD || "note",
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
