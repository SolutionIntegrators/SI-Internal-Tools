// Supabase PostgREST. The service_role key bypasses row-level security, so it
// stays in Worker secrets and is never sent to the browser.
import { fetchJson, requireVar } from "../lib/http.js";

function headers(env) {
  const key = requireVar(env, "SUPABASE_SERVICE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/**
 * Read rows from a table. `filters` are PostgREST query params, e.g.
 * { status: "eq.active", or: "(name.ilike.*acme*)" }.
 */
export async function selectRows(env, table, { select = "*", limit = 20, order, filters = {} } = {}) {
  const url = requireVar(env, "SUPABASE_URL").replace(/\/$/, "");
  const params = new URLSearchParams({ select, limit: String(limit) });
  if (order) params.set("order", order);
  for (const [key, value] of Object.entries(filters)) params.set(key, value);

  return (
    (await fetchJson("Supabase", `${url}/rest/v1/${encodeURIComponent(table)}?${params}`, {
      headers: headers(env),
    })) || []
  );
}

/**
 * Case-insensitive search across `columns`. PostgREST `or=` takes a
 * comma-separated list, and commas or parens inside the term would break it,
 * so they are stripped rather than escaped.
 */
export async function searchTable(env, table, query, columns, limit = 15) {
  const term = String(query).replace(/[(),*]/g, " ").trim();
  if (!term) return selectRows(env, table, { limit });
  const clauses = columns.map((column) => `${column}.ilike.*${term}*`).join(",");
  return selectRows(env, table, { limit, filters: { or: `(${clauses})` } });
}

/** Tables the dashboard reads, as a comma-separated var. First one is the projects table. */
export function configuredTables(env) {
  return (env.SUPABASE_TABLES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}
