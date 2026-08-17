// Pure helpers behind the money write actions. Kept out of the route so the
// validation rules can be tested without touching Airtable.

/**
 * Airtable record ids are always "rec" plus 14 alphanumerics. Anything else is
 * rejected before it can be pasted into a URL.
 */
export function validRecordId(id) {
  return typeof id === "string" && /^rec[A-Za-z0-9]{14}$/.test(id);
}

/** A plain calendar date, or null. Throws rather than sending junk upstream. */
export function normalizeDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${value}"`);
  }
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`"${value}" is not a real date`);
  }
  return value;
}

/**
 * Invoice statuses the dashboard is allowed to set. The list is the Status
 * column's own options minus the destructive ones — Home Base can mark an
 * invoice paid or put it back, but "Project Cancelled" and "Delete" stay in
 * Airtable where they have context around them.
 */
export function allowedInvoiceStatuses(env) {
  return (env.AIRTABLE_INVOICE_WRITABLE_STATUSES || "Paid,In progress,Overdue")
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
}

/** Case-insensitive match that returns Airtable's own spelling of the option. */
export function resolveInvoiceStatus(env, requested) {
  if (typeof requested !== "string" || !requested.trim()) return null;
  const wanted = requested.trim().toLowerCase();
  return allowedInvoiceStatuses(env).find((status) => status.toLowerCase() === wanted) || null;
}

/**
 * Recurring Items are rules, not one row per payment, so "paid" is recorded as
 * a high-water mark: every occurrence on or before Paid Through is settled.
 * Marking an occurrence paid only ever moves that mark forward, so checking
 * off a later bill can't quietly un-pay an earlier one.
 */
export function advancePaidThrough(current, occurrence) {
  const from = normalizeDate(current);
  const to = normalizeDate(occurrence);
  if (!to) throw new Error("Expected the occurrence date being paid");
  return !from || to > from ? to : from;
}

/** True when an occurrence falls on or before the paid-through mark. */
export function isSettled(occurrence, paidThrough) {
  return Boolean(paidThrough) && occurrence <= paidThrough;
}
