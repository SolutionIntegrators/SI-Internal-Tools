// Twelve months in calendar order, not alphabetical — the source of truth
// both for reading rows out of Financial Summary and for laying them left to
// right on the annual chart.
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// The one Financial Summary field map, shared by the month and year reads so
// a renamed Airtable column only has to change in one place.
export function summaryFields(env) {
  return {
    month: env.AIRTABLE_SUMMARY_MONTH_FIELD || "Month",
    year: env.AIRTABLE_SUMMARY_YEAR_FIELD || "Year",
    goal: env.AIRTABLE_SUMMARY_GOAL_FIELD || "🎯 Income",
    actual: env.AIRTABLE_SUMMARY_ACTUAL_FIELD || "💪🏾Total Income",
    projected: env.AIRTABLE_SUMMARY_PROJECTED_FIELD || "🤔 Expected Income",
  };
}

/**
 * Sums a year's worth of Financial Summary rows into the four figures Ashley
 * already tracks on Airtable's own "Year over Year Stats" page — same
 * fields, same arithmetic (actual minus goal, actual averaged over however
 * many month-rows exist), so the two can never quietly disagree. A month
 * with no row yet contributes zero and is excluded from the average, which
 * is how Airtable's own "average" summary behaves over existing rows.
 */
export function annualSummary(year, monthRows) {
  // Summed from the exact per-row values before anything is rounded — round
  // each of 12 rows first and the total can drift a few dollars from what
  // Airtable's own sum shows. Only the total gets rounded, once.
  const annualSales = Math.round(sumBy(monthRows, "actual"));
  const projectedTotal = Math.round(sumBy(monthRows, "projected"));
  const goalTotal = Math.round(sumBy(monthRows, "goal"));
  const rowCount = monthRows.filter((row) => row.hasRow).length;

  return {
    year,
    // Individual months are rounded here for display only, after the totals
    // above were already computed from the unrounded figures.
    months: monthRows.map(({ hasRow, goal, actual, projected, ...rest }) => ({
      ...rest,
      goal: Math.round(goal),
      actual: Math.round(actual),
      projected: Math.round(projected),
    })),
    annualSales,
    projectedTotal,
    goalTotal,
    distanceToGoal: annualSales - goalTotal,
    averageMonthlySales: rowCount ? Math.round(annualSales / rowCount) : 0,
  };
}

function sumBy(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0);
}
