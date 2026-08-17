// Airtable REST API with a personal access token.
// Field and table names live in wrangler.toml vars rather than in code: every
// Airtable base is shaped differently, and Ashley's should be readable and
// editable without touching this file.
import { fetchJson, requireVar, ConfigError } from "../lib/http.js";

const BASE = "https://api.airtable.com/v0";

function headers(env) {
  return { Authorization: `Bearer ${requireVar(env, "AIRTABLE_TOKEN")}` };
}

/**
 * One page of records. `filterByFormula` and `sort` are Airtable's own; see
 * https://airtable.com/developers/web/api/list-records
 */
export async function listRecords(env, baseId, table, options = {}) {
  if (!baseId) throw new ConfigError("Airtable base id is not set");
  if (!table) throw new ConfigError("Airtable table name is not set");

  const params = new URLSearchParams();
  if (options.filterByFormula) params.set("filterByFormula", options.filterByFormula);
  if (options.maxRecords) params.set("maxRecords", String(options.maxRecords));
  if (options.pageSize) params.set("pageSize", String(options.pageSize));
  for (const [index, sort] of (options.sort || []).entries()) {
    params.set(`sort[${index}][field]`, sort.field);
    params.set(`sort[${index}][direction]`, sort.direction || "asc");
  }

  const url = `${BASE}/${baseId}/${encodeURIComponent(table)}?${params}`;
  const data = await fetchJson("Airtable", url, { headers: headers(env) });
  return data.records || [];
}

/** Airtable formula string literal — escapes quotes so a client name can't break the formula. */
export function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Records whose ISO date field falls in [startIso, endIso]. */
export function dateRangeFormula(field, startIso, endIso) {
  return `AND(IS_AFTER({${field}}, ${quote(addDay(startIso, -1))}), IS_BEFORE({${field}}, ${quote(addDay(endIso, 1))}))`;
}

function addDay(isoDate, days) {
  const shifted = new Date(`${isoDate}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Airtable returns currency as a number, but hand-typed columns can be strings. */
export function toAmount(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatMoney(amount) {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

/** Single-select, linked-record, and plain-text fields all flatten to a string. */
export function toText(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(", ");
  if (typeof value === "object") return value.name || value.value || "";
  return String(value);
}

/** One record by id. Used before a write so an undo has the prior value. */
export async function getRecord(env, baseId, table, recordId) {
  if (!baseId) throw new ConfigError("Airtable base id is not set");
  if (!table) throw new ConfigError("Airtable table name is not set");
  const url = `${BASE}/${baseId}/${encodeURIComponent(table)}/${recordId}`;
  return fetchJson("Airtable", url, { headers: headers(env) });
}

/**
 * Patch named fields on one record, leaving every other field alone. Requires
 * the token to carry the data.records:write scope — with a read-only token
 * Airtable answers 403 and that surfaces as an "Airtable said no" toast.
 */
export async function updateRecord(env, baseId, table, recordId, fields) {
  if (!baseId) throw new ConfigError("Airtable base id is not set");
  if (!table) throw new ConfigError("Airtable table name is not set");
  const url = `${BASE}/${baseId}/${encodeURIComponent(table)}/${recordId}`;
  return fetchJson("Airtable", url, {
    method: "PATCH",
    headers: { ...headers(env), "content-type": "application/json" },
    body: JSON.stringify({ fields }),
  });
}
