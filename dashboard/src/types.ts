// Shapes of the JSON files written by sil/export.py (dashboard/public/data/).

export type Num = number | null;

export interface Company {
  cik: number;
  ticker: string;
  name: string;
  cohort: "specialty" | "benchmark" | "ai_indicator";
  segment: string;
  status: "active" | "acquired" | "exited";
  statusYear: number | null;
  statusNote: string | null;
  note: string | null;
  comparable: boolean;
  secName: string | null;
  sic: string | null;
  incorporated: string | null;
  firstFiling: string | null;
  lastFiling: string | null;
  n10k: number;
  n10q: number;
  filings: number;
  firstQuarter: string | null;
  lastQuarter: string | null;
  latest?: Record<string, Num>;
  /** posterior summaries: param -> [mean, lo (5.5%), hi (94.5%)]; beta params are "beta:<feature>" */
  model?: Record<string, [Num, Num, Num]>;
  exposure?: { geo: Num; prof: Num };
  investment?: { kappa: Num; d_rate: Num; d_fin: Num };
  /** filings per calendar year by kind: annual, quarterly, current, proxy, insider, other */
  filingsByYear?: Record<string, Record<string, number>>;
  recentFilings?: { form: string; filed: string; period: string | null; url: string }[];
}

export interface Panel {
  quarters: string[];
  metrics: string[];
  series: Record<string, Record<string, (Num | string)[]>>;
}

export interface DriverInfo {
  key: string;
  label: string;
  unit: string;
  group: string;
}

export interface Macro {
  quarters: string[];
  partial: boolean[];
  drivers: DriverInfo[];
  values: Record<string, Num[]>;
  industryShock: { quarters: string[]; mean: Num[]; p10: Num[]; p90: Num[] };
}

export interface Disclosure {
  years: number[];
  themes: string[];
  /** cik -> theme -> share of that year's 10-K/10-Q filings mentioning the theme; plus "filings" counts */
  series: Record<string, Record<string, Num[]>>;
}

export interface Overlay {
  key: string;
  label: string;
  exposure: string;
  points: number[];
  basis: string;
}

export interface ScenarioShock {
  features: number[][]; // K x H, z units
  f: number[]; // H
  ust5y: number[];
  nfci: number[];
  equity: number[];
  growth: number[];
}

export interface Scenario {
  key: string;
  name: string;
  story: string;
  shock: ScenarioShock;
  natural: {
    legalPpiYoy: number[];
    logGpr: number[];
    nfci: number[];
    ust5y: number[];
    equityRet: number[];
    growth: number[];
    fByQuarter: Record<string, number>;
  };
  overlays: Overlay[];
}

export interface ModelCompany {
  cik: number;
  stream: number;
  mu: number[];
  rho: number[];
  beta: number[][]; // D x K
  lam: number[];
  sigma: number[];
  expenseRatio: number;
  lastLrs: number[];
  /** the model's industry shock in the quarters of lastLrs (to take catastrophes out of the persistence level) */
  lastF: number[];
  npeQ: number;
  growth: number;
  equity: number;
  invToEquity: number;
  niiYield: number;
  kappa: number;
  kappaC: number;
  dRate: number;
  dFin: number;
  eqSecToEquity: number;
  otherIncomeQ: number;
  payout: number;
  exposures: Record<string, number>;
}

export interface SummaryStats {
  lr: number[][]; // 5 quantiles x H
  cr: number[][];
  roe: number[][];
  bvx: number[][];
  cap: number[][];
  p_cr_over_100: number[];
  p_year_cr_over_100: number[];
  bv_8q: number[];
  p_bv_down_10: number;
  cap_8q: number[];
  p_cap_negative: number;
}

export interface ModelData {
  end: string;
  horizon: string[];
  features: string[];
  featureLabels: Record<string, string>;
  featureUnits: Record<string, string>;
  featureMean: Record<string, number>;
  featureSd: Record<string, number>;
  draws: number;
  tax: number;
  seedBase: number;
  diagnostics: { max_r_hat: number; min_ess_bulk: number; divergences: number; parameters_checked: number; seconds: number };
  companies: ModelCompany[];
  base: {
    features: number[][][]; // K x P x H
    f: number[][]; // P x H
    ust5y: number[][];
    nfci: number[][];
    equity: number[][];
    start: { ust5y: number; nfci: number };
  };
  scenarios: Scenario[];
  /** the Python reference simulations live in reference.json (read by scripts/findings.py, not by the page) */
  referenceSummaries?: Record<string, Record<string, SummaryStats>>;
}

export interface BacktestHorizon {
  h: number;
  n: number;
  mae_model?: number;
  mae_model_known?: number;
  mae_last4?: number;
  mae_average?: number;
  cover80: number;
  cover50: number;
}

export interface Backtest {
  origins: string[];
  forecasts: number;
  companies: number;
  by_horizon: BacktestHorizon[];
  annual: Record<string, Record<string, number>>;
}

export interface Meta {
  built: string;
  dataThrough: string;
  sources: { source: string; rows: number; loaded: string }[];
  xbrl: { facts: number; tags: number; lastFiled: string };
  panel: { companies: number; observations: number; first: string; last: string };
  diagnostics: ModelData["diagnostics"];
}

export interface AppData {
  meta: Meta;
  companies: Company[];
  byCik: Map<number, Company>;
  panel: Panel;
  macro: Macro;
  disclosure: Disclosure;
  model: ModelData;
  backtest: Backtest | null;
}
