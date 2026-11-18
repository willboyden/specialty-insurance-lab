// The shape of public/data/people.json (written by sil/people.py).
import type { Num } from "../types";

export interface HeadcountSource {
  fiscalYear: number;
  employees: number;
  fullTime: number | null;
  asOf: string | null;
  snippet: string | null;
  method: string;
  url: string;
  accession: string;
  filed: string;
  form: string;
  /** the insurance operations' staff, when a group with non-insurance businesses states it */
  insurance?: number | null;
  insuranceBasis?: string | null;
}

/** Share of the company's 10-K/10-Q filings mentioning each technology theme, by filing year (techYears). */
export type TechShares = { filings: number[] } & Record<string, Num[] | number[]>;

export interface PeopleCompany {
  /** reported 10-K headcount by fiscal year (null until the filing documents are downloaded and parsed); for a
   *  group with non-insurance businesses (employeesBasis "insurance operations") its insurance operations' staff */
  employees: Num[];
  /** the group's total headcount, when employees counts its insurance operations only */
  employeesTotal?: Num[] | null;
  employeesBasis?: "company" | "insurance operations";
  /** Form 5500: active participants summed over the company's 401(k) plans (US headcount proxy) */
  plan: Num[];
  plans: Num[];
  npe: Num[];
  uwExpense: Num[];
  sbc: Num[];
  dcCost: Num[];
  labor: Num[];
  /** capital spending on property, equipment and software (cash-flow statement) */
  capex: Num[];
  software: Num[];
  sponsors: string[];
  headcountSources: HeadcountSource[];
  tech: TechShares | null;
}

export interface PeopleData {
  version: number;
  years: number[];
  techYears: number[];
  companies: Record<string, PeopleCompany>;
  themes: Record<string, string[]>;
  industry: {
    employment: Num[]; // BLS, thousands, annual average
    fte: Num[]; // BEA full-time equivalents, thousands
    wagePerFte: Num[]; // BEA wages and salaries per FTE, dollars
    eciYoy: Num[]; // Employment Cost Index (wages and salaries), year-over-year
    series: { id: string; title: string | null; units: string; frequency: string; url: string }[];
  };
  ai: Record<string, { rd: Num[]; capex: Num[] }>;
  coverage: {
    headcountReports: number;
    headcountFound: number;
    annualReportsListed: number;
    planYears: [number, number];
    planRows: number;
    companiesWithPlan: number;
    companiesWithReported: number;
  };
  sources: Record<string, string>;
}
