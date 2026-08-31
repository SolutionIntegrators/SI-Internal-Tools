// Pure shaping for the Budget section and the Debt Payoff card.
//
// Kept apart from the fetching so the arithmetic — which is the part that would
// quietly mislead if it were wrong — can be tested without Airtable.

import { UNCATEGORIZED } from "./categoryMap.js";

const GROUP_ORDER = ["Operating Expense", "Payroll", "Debt / New Commitment"];

/**
 * Budget rows grouped the way the card renders them.
 *
 * `actuals` is a { category: amount } map, or null when no source is connected.
 * Null and zero are deliberately different: null means "we do not know what you
 * spent" and the card says so, while zero means "you have spent nothing on
 * this". Collapsing them would turn a missing integration into a clean bill of
 * health, which is the most dangerous thing this card could do.
 */
export function budgetRows(records, actuals, { field }) {
  const known = actuals || {};
  const rows = records.map((record) => {
    const category = String(record.fields?.[field.category] || "").trim() || "Unnamed";
    const budget = toNumber(record.fields?.[field.budget]);
    const actual = actuals ? Number(known[category] || 0) : null;
    return {
      id: record.id,
      category,
      group: String(record.fields?.[field.group]?.name || record.fields?.[field.group] || "Other"),
      budget,
      actual,
      // Positive means over budget — the direction that costs money.
      variance: actual === null ? null : Math.round(actual - budget),
      percent: actual === null || budget <= 0 ? null : Math.round((actual / budget) * 100),
      note: String(record.fields?.[field.note] || ""),
    };
  });

  // Spend that matched no budget row still has to appear somewhere, or the
  // category totals will not reconcile with what actually left the account.
  if (actuals) {
    const budgeted = new Set(rows.map((row) => row.category));
    for (const [category, amount] of Object.entries(known)) {
      if (budgeted.has(category) || !amount) continue;
      rows.push({
        id: null,
        category: category === UNCATEGORIZED ? "Uncategorized" : category,
        group: "Unbudgeted",
        budget: 0,
        actual: Math.round(amount),
        variance: Math.round(amount),
        percent: null,
        note: "No budget line — add one, or add a rule to categoryMap.js.",
      });
    }
  }

  const groups = [];
  for (const name of [...GROUP_ORDER, "Other", "Unbudgeted"]) {
    const inGroup = rows.filter((row) => row.group === name);
    if (!inGroup.length) continue;
    inGroup.sort((a, b) => b.budget - a.budget || a.category.localeCompare(b.category));
    groups.push({
      name,
      rows: inGroup,
      budget: inGroup.reduce((sum, row) => sum + row.budget, 0),
      actual: actuals ? inGroup.reduce((sum, row) => sum + (row.actual || 0), 0) : null,
    });
  }

  const budget = rows.reduce((sum, row) => sum + row.budget, 0);
  return {
    groups,
    totals: {
      budget: Math.round(budget),
      actual: actuals ? Math.round(rows.reduce((sum, row) => sum + (row.actual || 0), 0)) : null,
    },
  };
}

/**
 * Debt rows with pace-to-payoff.
 *
 * Pace is only shown when it can actually be computed — a balance and a payment
 * above zero. A debt with no balance filled in reports `needsSetup` so the card
 * can ask for one instead of drawing a progress bar against nothing.
 */
export function debtRows(records, { field }) {
  return records.map((record) => {
    const start = toNumber(record.fields?.[field.start]);
    const current = toNumber(record.fields?.[field.current]);
    const payment = toNumber(record.fields?.[field.payment]);
    const hasBalances = start > 0 && current > 0;

    return {
      id: record.id,
      name: String(record.fields?.[field.name] || "Unnamed"),
      start,
      current,
      payment,
      asOf: String(record.fields?.[field.asOf] || "").slice(0, 10),
      paidOff: hasBalances ? Math.max(0, Math.round(start - current)) : null,
      percent: hasBalances ? Math.min(100, Math.round(((start - current) / start) * 100)) : null,
      // Rounded up: 4.2 months means it is not gone until the fifth payment.
      monthsLeft: current > 0 && payment > 0 ? Math.ceil(current / payment) : null,
      needsSetup: !hasBalances,
    };
  });
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
