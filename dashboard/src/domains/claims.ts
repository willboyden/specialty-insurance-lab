// The shape of public/data/claims.json (written by sil/claims.py): the loss-reserve roll-forward of every carrier,
// by fiscal year, plus quarterly paid and incurred loss ratios and, once the 10-K XBRL instances are downloaded,
// the accident-year claims development (triangles, claim counts, payout pattern).
import type { Num } from "../types";

/** fiscal-year ratios and amounts (USD) from the roll-forward; see sil/claims.py for the definitions */
export type ClaimsMetricKey =
  | "paid_lr" | "incurred_lr" | "paid_to_incurred" | "first_year_payout" | "runoff_speed" | "survival"
  | "reserve_to_npe" | "reserve_leverage" | "dev_pct_open" | "pyd_ratio" | "ceded_share" | "ibnr_share"
  | "reserve_growth" | "acquired_pct_open" | "rollforward_gap";

export type ClaimsAmountKey =
  | "npe" | "losses" | "cy_losses" | "py_development" | "paid_cy" | "paid_py" | "paid" | "acquired"
  | "net_reserves" | "net_reserves_open" | "gross_reserves" | "equity";

export interface ClaimsCompany {
  /** one array per key, aligned to ClaimsData.years; keys without any value are left out */
  y: Partial<Record<ClaimsMetricKey | ClaimsAmountKey, Num[]>>;
  /** how paid losses were read each year: cy+py | total | total-cy | none */
  basis: (string | null)[];
}

export interface ClaimsLine {
  name: string;
  ays: number[];
  /** accident year x development age (index 0 = the accident year itself), cumulative USD */
  incurred: Num[][];
  paid: Num[][];
  ibnr: Num[];
  claims: Num[];
  /** average share of an accident year's claims paid in development year n (index 0 = year 1) */
  payout: Num[];
  size: Num;
}

export interface ClaimsTriangleSet {
  fy: number;
  accession: string;
  lines: ClaimsLine[];
}

export interface ClaimsData {
  version: number;
  generated: string;
  years: number[];
  metrics: string[];
  amounts: string[];
  companies: Record<string, ClaimsCompany>;
  /** segment -> metric -> median per fiscal year (comparable carriers, at least three) */
  segmentMedians: Record<string, Partial<Record<ClaimsMetricKey, Num[]>>>;
  quarters: string[];
  quarterly: Record<string, { paid: Num[]; incurred: Num[] }>;
  triangles: Record<string, ClaimsTriangleSet>;
  coverage: {
    companies: number;
    companyYears: number;
    withPaid: number;
    firstYear: number;
    lastYear: number;
    lastYearCompanies: number;
    triangleCompanies: number;
    instancesRead: number;
  };
}
