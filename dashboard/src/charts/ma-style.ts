// Buyer groups of the M&A section: categorical slots s1-s4 in fixed order (validated in both themes: they pass
// the CVD and normal-vision checks; in light mode s3/s4 fall under 3:1 against the surface, so every view keeps
// direct labels and a table view). A pending deal with no identified buyer is context gray, never a hue.
import type { MaDeal, MaGroup } from "../domains/ma";
import { money, times } from "../format";

export const GROUPS: MaGroup[] = ["US insurer", "Japanese insurer", "Other non-US insurer", "Private capital"];

export const GROUP_COLOR: Record<string, string> = {
  "US insurer": "var(--s1)",
  "Japanese insurer": "var(--s2)",
  "Other non-US insurer": "var(--s3)",
  "Private capital": "var(--s4)",
  "Buyer not yet identified": "var(--context-strong)",
  "Stopped reporting": "var(--critical)",
};

export const GROUP_HELP: Record<string, string> = {
  "US insurer": "US insurers and reinsurers (The Hartford, Progressive, AIG, Markel, Berkshire Hathaway, ...)",
  "Japanese insurer": "Tokio Marine and Sompo",
  "Other non-US insurer": "Insurers and insurance groups from Europe, Canada, Bermuda and China",
  "Private capital": "Private equity, alternative-capital reinsurers and family buy-outs",
  "Buyer not yet identified": "A take-private is pending; the buyer is named in the merger proxy",
};

export function groupColor(g: string): string {
  return GROUP_COLOR[g] ?? "var(--context-strong)";
}

/** "$78.00 per share in cash" / "stock and cash" / "not verified" */
export function priceLabel(d: MaDeal): string {
  if (d.status === "pending" && d.price == null) return "terms in the merger proxy";
  if (d.price != null) return `$${d.price.toFixed(2)} per share${d.consideration === "cash" ? " in cash" : d.consideration === "mixed" ? " (stock and cash)" : ""}`;
  if (d.consideration === "mixed") return "stock and cash";
  return "price not verified";
}

export function earlierLabel(d: MaDeal): string | null {
  if (!d.earlierPrices.length) return null;
  return d.earlierPrices.map((e) => (e.kind === "agreed"
    ? `first agreed at $${e.price.toFixed(2)}, then amended`
    : `after a $${e.price.toFixed(2)} proposal`)).join("; ");
}

const SHORT: Record<string, string> = {
  "American Financial Group (Great American)": "Great American (AFG)",
  "TowerBrook Capital Partners and Further Global Capital Management": "TowerBrook & Further Global",
  "Karfunkel-Zyskind family and Stone Point Capital": "Founders & Stone Point",
  "Apollo Global Management": "Apollo",
  "Fosun International": "Fosun",
  "Fairfax Financial": "Fairfax",
  "Intact Financial": "Intact",
  "Sompo Holdings": "Sompo",
  "Enstar Group": "Enstar",
  "American Family Insurance": "American Family",
};

export function shortBuyer(d: MaDeal): string {
  if (!d.acquirer) return d.status === "pending" ? "buyer pending" : "buyer not verified";
  return SHORT[d.acquirer] ?? d.acquirer;
}

/** "Meadowbrook (AmeriTrust)" -> "Meadowbrook" */
export function shortTarget(name: string): string {
  return name.replace(/ \(.*\)$/, "");
}

export function valueLine(d: MaDeal): string {
  const parts = [];
  if (d.value != null) parts.push(money(d.value));
  if (d.pb != null) parts.push(`${times(d.pb)} book`);
  return parts.join(" · ");
}
