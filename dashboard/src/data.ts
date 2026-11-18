// Loading the exported JSON, the metric registry, and small helpers over the panel.
import type { AppData, Backtest, Company, Disclosure, Macro, Meta, ModelData, Num, Panel } from "./types";
import type { ClaimsData } from "./domains/claims";
import type { CatastropheData } from "./domains/catastrophe";
import type { PeopleData } from "./domains/people";
import type { MaData } from "./domains/ma";
import type { MetricKey } from "./state";
import { money, pct, pts, times } from "./format";

const BASE = import.meta.env.BASE_URL + "data/";

async function getJson<T>(name: string, optional = false): Promise<T | null> {
  const res = await fetch(BASE + name);
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`could not load ${name}: HTTP ${res.status}`);
  }
  // a dev server answers a missing file with the page itself (200, text/html): an optional file is then absent
  if (optional && !(res.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

export async function loadAll(): Promise<AppData> {
  const [meta, companies, panel, macro, disclosure, model, backtest, claims, catastrophe, people, ma] = await Promise.all([
    getJson<Meta>("meta.json"),
    getJson<Company[]>("companies.json"),
    getJson<Panel>("panel.json"),
    getJson<Macro>("macro.json"),
    getJson<Disclosure>("disclosure.json"),
    getJson<ModelData>("model.json"),
    getJson<Backtest>("backtest.json", true),
    getJson<ClaimsData>("claims.json", true),
    getJson<CatastropheData>("catastrophe.json", true),
    getJson<PeopleData>("people.json", true),
    getJson<MaData>("ma.json", true),
  ]);
  const list = (companies ?? []).filter((c) => c.cohort !== "ai_indicator");
  return {
    meta: meta!,
    companies: list,
    byCik: new Map(list.map((c) => [c.cik, c])),
    panel: panel!,
    macro: macro!,
    disclosure: disclosure!,
    model: model!,
    backtest,
    claims,
    catastrophe,
    people,
    ma,
  };
}

// ---------------------------------------------------------------- metrics
export interface MetricDef {
  key: MetricKey;
  label: string;
  short: string;
  fmt: (v: Num) => string;
  better: "lower" | "higher" | "neutral";
  ref?: number; // reference line (e.g. 100% combined ratio)
  diverging?: boolean; // centered on zero (reserve development)
  help: string;
}

export const METRICS: MetricDef[] = [
  {
    key: "combined_ratio_ttm", label: "Combined ratio", short: "CR", fmt: (v) => pct(v), better: "lower", ref: 1,
    help: "Losses plus expenses per dollar of premium earned, trailing four quarters. Below 100% = underwriting profit.",
  },
  {
    key: "loss_ratio_ttm", label: "Loss ratio", short: "LR", fmt: (v) => pct(v), better: "lower",
    help: "Losses and loss-adjustment expenses per dollar of net premium earned, trailing four quarters.",
  },
  {
    key: "cy_loss_ratio_ttm", label: "Accident-year loss ratio", short: "AY LR", fmt: (v) => pct(v), better: "lower",
    help: "Losses for the current accident year only: the loss ratio before reserve releases or charges.",
  },
  {
    key: "pyd_ratio_ttm", label: "Prior-year reserve development", short: "PYD", fmt: (v) => pts(v), better: "lower",
    diverging: true,
    help: "Change in estimates for prior years' claims, as points of premium. Negative = favorable (reserves released).",
  },
  {
    key: "expense_ratio_ttm", label: "Expense ratio", short: "ER", fmt: (v) => pct(v), better: "lower",
    help: "Acquisition plus other underwriting expenses per dollar of premium (rebuilt from XBRL tags; see methods).",
  },
  {
    key: "roe_ttm", label: "Return on equity", short: "ROE", fmt: (v) => pct(v), better: "higher",
    help: "Net income over average shareholders' equity, trailing four quarters.",
  },
  {
    key: "npe_growth_yoy", label: "Premium growth", short: "Growth", fmt: (v) => pct(v), better: "neutral",
    help: "Growth in net premiums earned, trailing four quarters vs the four before.",
  },
  {
    key: "nii_yield", label: "Investment yield", short: "Yield", fmt: (v) => pct(v, 2), better: "higher",
    help: "Net investment income (annualized) over average invested assets.",
  },
  {
    key: "reserve_to_npe", label: "Reserve leverage", short: "Res/Prem", fmt: (v) => times(v), better: "neutral",
    help: "Net loss reserves over trailing premium: how long-tail the book is, and how much a reserve error would hurt.",
  },
  {
    key: "npw_to_equity", label: "Premium leverage", short: "Prem/Eq", fmt: (v) => times(v), better: "neutral",
    help: "Net premiums written (trailing four quarters) per dollar of equity.",
  },
  {
    key: "equity_share_of_inv", label: "Equities share of investments", short: "Eq %", fmt: (v) => pct(v), better: "neutral",
    help: "Equity securities as a share of total investments: exposure to a stock-market fall.",
  },
  {
    key: "bv_growth_yoy", label: "Book value growth", short: "BV g", fmt: (v) => pct(v), better: "higher",
    help: "Shareholders' equity vs four quarters earlier (after dividends and buybacks).",
  },
];

export const METRIC = new Map(METRICS.map((m) => [m.key, m]));

export const SEGMENT_ORDER = [
  "E&S and specialty commercial",
  "Diversified specialty",
  "Bermuda and international specialty (re)insurance",
  "Niche specialty (workers' comp, medical liability)",
  "Standard commercial and personal lines",
];

export const SEGMENT_SHORT: Record<string, string> = {
  "E&S and specialty commercial": "E&S / specialty commercial",
  "Diversified specialty": "Diversified specialty",
  "Bermuda and international specialty (re)insurance": "Bermuda / international",
  "Niche specialty (workers' comp, medical liability)": "Niche (WC, med-mal)",
  "Standard commercial and personal lines": "Benchmark: standard lines",
};

// ---------------------------------------------------------------- panel helpers
export function series(data: AppData, cik: number, metric: string): Num[] {
  const s = data.panel.series[String(cik)];
  if (!s || !s[metric]) return data.panel.quarters.map(() => null);
  return s[metric] as Num[];
}

export function valueAt(data: AppData, cik: number, metric: string, quarter: string): Num {
  const i = data.panel.quarters.indexOf(quarter);
  if (i < 0) return null;
  return series(data, cik, metric)[i] ?? null;
}

export function latestValue(data: AppData, cik: number, metric: string): { v: Num; q: string | null } {
  const s = series(data, cik, metric);
  for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return { v: s[i], q: data.panel.quarters[i] };
  return { v: null, q: null };
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** premium-weighted average of a ratio across companies at each quarter (weights = TTM premium) */
export function weightedSeries(data: AppData, ciks: number[], metric: string): Num[] {
  return data.panel.quarters.map((_, i) => {
    let num = 0;
    let den = 0;
    for (const c of ciks) {
      const v = series(data, c, metric)[i];
      const w = series(data, c, "npe_ttm")[i];
      if (v != null && w != null && w > 0) {
        num += v * w;
        den += w;
      }
    }
    return den > 0 ? num / den : null;
  });
}

export function medianSeries(data: AppData, ciks: number[], metric: string): Num[] {
  return data.panel.quarters.map((_, i) => {
    const vals: number[] = [];
    for (const c of ciks) {
      const v = series(data, c, metric)[i];
      if (v != null) vals.push(v);
    }
    return vals.length >= 3 ? median(vals) : null;
  });
}

export function visibleCompanies(data: AppData, segments: string[], historical: boolean): Company[] {
  return data.companies.filter(
    (c) => c.comparable && segments.includes(c.segment) && (historical || c.status === "active"),
  );
}

export function displayName(c: Company): string {
  return `${c.name} (${c.ticker})`;
}

export { money };
