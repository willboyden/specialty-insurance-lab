// The shape of public/data/catastrophe.json (written by sil/catastrophe.py).
import type { Num } from "../types";

export interface CatSource {
  key: string;
  name: string;
  url: string;
  coverage: string;
  rows: number;
  retrieved: string | null;
}

export interface CatFitTerm {
  key: string; // "(intercept)" | hurricane | convective | flood | wildfire
  label: string;
  coef: Num; // standardized: sigma of shock per standard deviation of the index
  se: Num;
  t: Num;
  r: Num; // simple correlation with the shock
}

export interface CatCompany {
  cik: number;
  ticker: string;
  name: string;
  segment: string;
  status: string;
  comparable: boolean;
  lam: [Num, Num, Num]; // posterior mean, 5.5%, 94.5%: loss-ratio points (as a fraction) per 1 sigma of shock
}

export interface CatReportedSeries {
  q: string[];
  usd: Num[];
  ratio: Num[]; // catastrophe losses / net premiums earned in the quarter
  basis: string[]; // quarter | derived
  model: Num[] | null; // lam x shock: the model's catastrophe component of the loss ratio
}

export type CatYearKey =
  | "landfalls" | "cat1" | "cat2" | "cat3" | "cat4" | "cat5" | "ace" | "namedStorms" | "hurricanes" | "tornadoes"
  | "sigTornadoes" | "hailReports" | "sigHail" | "windReports" | "sigWind" | "wildfireFires" | "wildfireAcres"
  | "nfipPaid" | "nfipClaims" | "quakesM5" | "quakesM6" | "billionCost" | "billionCount" | "stormDamage" | "oniAso"
  | "globalTemp";

export type CatStateKey =
  | "nfip_paid" | "storm_damage" | "storm_damage_hurricane" | "storm_damage_convective" | "storm_damage_wildfire"
  | "storm_damage_flood" | "sig_hail" | "sig_tornadoes" | "fema_major";

export interface CatastropheData {
  version: number;
  built: string;
  femaNote: string;
  sources: CatSource[];
  quarters: string[];
  partial: boolean[];
  q: {
    f: Num[];
    f10: Num[];
    f90: Num[];
    fitted: Num[];
    landfallIndex: Num[];
    landfalls: Num[];
    sigConvective: Num[];
    nfipPaid: Num[];
    wildfireDamage: Num[];
    stormDamage: Num[];
    billionCost: Num[];
    oni: Num[];
    quakesM6: Num[];
  };
  fit: {
    window: [string, string] | null;
    n: number;
    r2: Num;
    adjR2: Num;
    cvR2: Num;
    terms: CatFitTerm[];
    billionR: Num;
    billionN: number;
    largest: { q: string; f: Num; fitted: Num }[];
  };
  oni: {
    latest: { year: number; season: string; anom: Num } | null; // the latest 3-month season
    latestAso: { year: number; anom: Num } | null; // the latest Aug-Oct season (the hurricane season's ENSO state)
  };
  years: number[];
  y: Record<CatYearKey, Num[]>;
  states: { codes: string[]; names: string[]; values: Record<CatStateKey, Num[]> };
  nfipEvents: { name: string; date: string; claims: number; paid: Num; state: string | null }[];
  companies: CatCompany[];
  reported: {
    available: boolean;
    documentsListed: number;
    companyQuarters: number;
    series: Record<string, CatReportedSeries>;
    validation: { pooledR: Num; n: number; perCompany: { cik: number; r: Num; n: number }[] } | null;
    examples: { cik: number; q: string; usd: Num; snippet: string; url: string }[];
  };
}
