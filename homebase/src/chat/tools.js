// Four read-only tools, each backed by a Worker function. Nothing here writes:
// adding a create-or-update tool is a deliberate follow-up with its own
// confirmation step, not something to slip in alongside a search.

import * as clickup from "../services/clickup.js";
import * as google from "../services/google.js";
import * as airtable from "../services/airtable.js";
import * as supabase from "../services/supabase.js";
import { requireVar } from "../lib/http.js";

export const TOOL_DEFINITIONS = [
  {
    name: "search_clickup",
    description:
      "Search ClickUp tasks and support tickets by keyword. Use this for anything about work in progress, task status, who owns something, deadlines, or open tickets. Returns matching tasks with status, client, assignees, and due date.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to match against task name, description, list, and status. A client name works well.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_calendar",
    description:
      "Look up calendar events in a date range. Use this for questions about meetings, calls, availability, or what a given day looks like.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional keywords to filter events by, e.g. a client name." },
        start_date: { type: "string", description: "Start of the range as YYYY-MM-DD. Defaults to today." },
        end_date: { type: "string", description: "End of the range as YYYY-MM-DD. Defaults to 14 days out." },
      },
      required: [],
    },
  },
  {
    name: "search_airtable",
    description:
      "Read records from one of Ashley's Airtable tables. 'income' is payments received, 'invoices' is money still owed, 'bills' is recurring expenses and their schedules, 'goals' is the weekly revenue targets, 'content' is the social content pipeline.",
    input_schema: {
      type: "object",
      properties: {
        base: {
          type: "string",
          enum: ["income", "invoices", "bills", "goals", "content"],
          description: "Which table to read.",
        },
        query: { type: "string", description: "Optional keywords to filter the returned records by." },
      },
      required: ["base"],
    },
  },
  {
    name: "search_supabase",
    description:
      "Read rows from the client portal and LMS database. Use this for portal-side client, project, or course data.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name. Call with an empty table to list the tables available." },
        query: { type: "string", description: "Optional keywords to match against text columns." },
      },
      required: [],
    },
  },
];

export async function runTool(env, name, input) {
  switch (name) {
    case "search_clickup":
      return searchClickup(env, input);
    case "search_calendar":
      return searchCalendar(env, input);
    case "search_airtable":
      return searchAirtable(env, input);
    case "search_supabase":
      return searchSupabase(env, input);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

async function searchClickup(env, { query }) {
  const teamId = requireVar(env, "CLICKUP_TEAM_ID");
  const tasks = await clickup.searchTasks(env, teamId, query || "");
  return { count: tasks.length, tasks: tasks.map(clickup.summarize) };
}

async function searchCalendar(env, { query, start_date: startDate, end_date: endDate }) {
  const start = startDate ? new Date(`${startDate}T00:00:00Z`) : new Date();
  const end = endDate ? new Date(`${endDate}T23:59:59Z`) : new Date(start.getTime() + 14 * 86400000);
  const events = await google.listEvents(env, { timeMin: start, timeMax: end, query, maxResults: 40 });
  return { count: events.length, events: events.map(google.summarize) };
}

const AIRTABLE_BASES = {
  income: ["AIRTABLE_MONEY_BASE_ID", "AIRTABLE_INCOME_TABLE"],
  invoices: ["AIRTABLE_MONEY_BASE_ID", "AIRTABLE_INVOICE_TABLE"],
  bills: ["AIRTABLE_BILLS_BASE_ID", "AIRTABLE_BILLS_TABLE"],
  goals: ["AIRTABLE_BILLS_BASE_ID", "AIRTABLE_GOALS_TABLE"],
  content: ["AIRTABLE_CONTENT_BASE_ID", "AIRTABLE_CONTENT_TABLE"],
};

async function searchAirtable(env, { base, query }) {
  const mapping = AIRTABLE_BASES[base];
  if (!mapping) return { error: `Unknown table "${base}". Use ${Object.keys(AIRTABLE_BASES).join(", ")}.` };
  const [baseVar, tableVar] = mapping;
  if (!env[baseVar]) return { error: `The ${base} table is not configured on this deployment.` };

  const records = await airtable.listRecords(env, env[baseVar], env[tableVar], { maxRecords: 50 });
  const rows = records.map((record) => record.fields);
  if (!query) return { count: rows.length, records: rows.slice(0, 15) };

  const needle = String(query).toLowerCase();
  const matched = rows.filter((fields) =>
    Object.values(fields).some((value) => airtable.toText(value).toLowerCase().includes(needle)),
  );
  return { count: matched.length, records: matched.slice(0, 15) };
}

async function searchSupabase(env, { table, query }) {
  const tables = supabase.configuredTables(env);
  if (!table) return { tables };
  if (tables.length && !tables.includes(table)) {
    return { error: `"${table}" is not one of the readable tables.`, tables };
  }
  const columns = (env.SUPABASE_SEARCH_COLUMNS || "name,title,email,status")
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  const rows = query
    ? await supabase.searchTable(env, table, query, columns)
    : await supabase.selectRows(env, table, { limit: 15 });
  return { count: rows.length, rows };
}
