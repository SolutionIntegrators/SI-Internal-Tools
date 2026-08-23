// POST /api/clients/milestones/:recordId — move one of a project's four dates.
//
// The Clients timeline and the calendar both draw from these same four
// columns on ALL Active Projects. A milestone id from either surface is
// "<record id>|<key>" — kickoff, implementation, walkthrough, or supportEnd —
// and this is the one place that turns a key back into the real Airtable
// column, via the same milestoneList() the readers use, so a write can never
// target a field the readers don't also know about.
import { json, badRequest, ConfigError } from "../lib/http.js";
import * as airtable from "../services/airtable.js";
import { milestoneList } from "../lib/projectFields.js";
import { normalizeDate } from "../lib/moneyEdits.js";

/** Airtable record ids: "rec" plus 14 alphanumerics — same shape used for money records. */
function validRecordId(id) {
  return typeof id === "string" && /^rec[A-Za-z0-9]{14}$/.test(id);
}

export async function handleSetMilestone(request, env, recordId) {
  if (!validRecordId(recordId)) return badRequest("Bad project id");
  const body = await request.json().catch(() => ({}));

  const entry = milestoneList(env).find((item) => item.key === body.key);
  if (!entry) {
    return badRequest(`key must be one of: ${milestoneList(env).map((item) => item.key).join(", ")}`);
  }

  let date;
  try {
    date = normalizeDate(body.date ?? null);
  } catch (err) {
    return badRequest(err.message);
  }
  if (!date) return badRequest("A milestone date can be moved, not cleared");

  if (!env.AIRTABLE_MONEY_BASE_ID || !env.AIRTABLE_PROJECTS_TABLE) {
    throw new ConfigError("the projects table is not set");
  }

  const baseId = env.AIRTABLE_MONEY_BASE_ID;
  const table = env.AIRTABLE_PROJECTS_TABLE;
  const before = await airtable.getRecord(env, baseId, table, recordId);
  const previousDate = String(before?.fields?.[entry.field] || "").slice(0, 10) || null;

  await airtable.updateRecord(env, baseId, table, recordId, { [entry.field]: date });
  return json({ ok: true, key: entry.key, label: entry.label, date, previousDate });
}
