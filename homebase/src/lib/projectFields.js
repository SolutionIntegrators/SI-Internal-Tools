// The one place ALL Active Projects' field names are named.
//
// tasks.js needs these to shape the Clients timeline; month.js needs the same
// four milestone dates for the calendar; the milestone write endpoint needs
// them to turn a logical key like "kickoff" back into the real Airtable
// column. All three used to keep their own copy — this is that copy.

export function projectFields(env) {
  return {
    name: env.AIRTABLE_PROJECT_NAME_FIELD || "Company Name",
    status: env.AIRTABLE_PROJECT_STATUS_FIELD || "Project Status",
    service: env.AIRTABLE_PROJECT_SERVICE_FIELD || "Service",
    start: env.AIRTABLE_PROJECT_START_FIELD || "1️⃣ Project Start",
    kickoff: env.AIRTABLE_PROJECT_KICKOFF_FIELD || "2️⃣ Kickoff Call",
    implementation: env.AIRTABLE_PROJECT_IMPLEMENTATION_FIELD || "5️⃣ Implementation",
    walkthrough: env.AIRTABLE_PROJECT_WALKTHROUGH_FIELD || "6️⃣ Walkthrough Call",
    supportEnd: env.AIRTABLE_PROJECT_SUPPORT_END_FIELD || "Support End",
    ongoingValue: env.AIRTABLE_PROJECT_ONGOING_VALUE || "Ongoing Support",
  };
}

/** The four dates a project's timeline is built from, in the order they occur. */
export const MILESTONE_KEYS = ["kickoff", "implementation", "walkthrough", "supportEnd"];

const MILESTONE_LABELS = {
  kickoff: "Kickoff Call",
  implementation: "Implementation",
  walkthrough: "Walkthrough",
  supportEnd: "Support ends",
};

/** [{key, field, label}] — key is what an edit request names, field is the real Airtable column. */
export function milestoneList(env) {
  const field = projectFields(env);
  return MILESTONE_KEYS.map((key) => ({ key, field: field[key], label: MILESTONE_LABELS[key] }));
}
