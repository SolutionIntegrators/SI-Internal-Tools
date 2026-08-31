// Maps QuickBooks expense "Type" values onto the clean Category Budgets names.
//
// Ashley's budget rows use her P&L line items. The expense records carry
// QuickBooks' own category list, which is messier: nested paths
// ("Cost of goods sold:Subcontractor expenses" alongside a plain
// "Subcontractor expenses"), a typo ("Merchant account feesh"), and accounts
// that are not expenses at all ("Novo Primary Account", "Owner draws").
//
// Rather than clean that list up in Airtable — which would mean touching
// historical records — the mapping lives here. It is ordered: the FIRST rule
// whose `match` is found in the lowercased type wins, so more specific rules
// go above more general ones. Extend it when a new type shows up in the
// Uncategorized bucket on the Budget card.

/** [substring to look for, Category Budgets name]. Order matters. */
export const CATEGORY_RULES = [
  // Specific before general: "credit card interest" must beat "interest".
  ["credit card interest", "Interest paid"],
  ["interest paid", "Interest paid"],
  ["interest", "Interest paid"],

  ["subcontractor", "Contractors"],
  ["contractor", "Contractors"],

  ["software & apps", "Software & subscriptions"],
  ["memberships & subscriptions", "Software & subscriptions"],
  ["subscription", "Software & subscriptions"],

  // The trailing "h" is a real typo in the option list, not a variant.
  ["merchant account fees", "Merchant account fees"],
  ["bank fees & service charges", "Bank fees & service charges"],
  ["commissions & fees", "Commissions & fees"],

  ["continuing education", "Continuing education"],
  ["advertising & marketing", "Advertising & marketing"],
  ["contributions to charities", "Contributions to charities"],
  ["client gifts", "Client Gifts"],

  ["owner's health insurance", "Owner's Health Insurance"],
  ["vehicle insurance", "Vehicle insurance"],
  ["gas & fuel", "Vehicle gas & fuel"],

  ["payroll processing", "Payroll Processing Fees"],
  ["payroll tax", "Payroll Taxes"],
  ["wages", "Wages"],
  ["payroll expenses", "Wages"],
  ["retirement", "Retirement"],

  ["legal & accounting", "Accounting fees"],
  ["accounting fees", "Accounting fees"],

  ["internet & tv", "Internet & TV services"],
  ["office supplies", "Office expenses"],
  ["office expenses", "Office expenses"],

  ["meals", "Meals"],
  ["travel", "Travel"],
  ["rent", "Rent/Lease"],
  ["lease", "Rent/Lease"],
];

/**
 * Anything landing here is deliberately NOT mapped: transfers, equity,
 * reconciliation noise, and income lines are not spending against a budget, so
 * folding them into one would overstate every category they touched.
 */
export const IGNORED = [
  "novo primary account",
  "payments to deposit",
  "opening balance equity",
  "retained earnings",
  "owner investments",
  "owner draws",
  "reconciliation discrepancies",
  "refunds to customers",
  "credit card rewards",
  "other income",
  "stripe capital",
  "discover credit card",
];

export const UNCATEGORIZED = "Uncategorized";

/**
 * The budget category a QuickBooks type belongs to. Returns null for types that
 * are deliberately ignored, and UNCATEGORIZED for ones nothing matched — those
 * surface on the card so the rules above can be extended rather than the money
 * quietly disappearing.
 */
export function categoryFor(type) {
  const text = String(type || "").trim().toLowerCase();
  if (!text) return UNCATEGORIZED;
  if (IGNORED.some((ignored) => text.includes(ignored))) return null;

  for (const [match, category] of CATEGORY_RULES) {
    if (text.includes(match)) return category;
  }
  return UNCATEGORIZED;
}

/**
 * Sum a set of expense records into { category: total }. Records are
 * `{ type, amount }` — whichever source they came from.
 */
export function sumByCategory(records) {
  const totals = {};
  for (const { type, amount } of records) {
    const category = categoryFor(type);
    if (!category) continue;
    const value = Number(amount);
    if (!Number.isFinite(value) || value === 0) continue;
    totals[category] = (totals[category] || 0) + value;
  }
  return totals;
}
