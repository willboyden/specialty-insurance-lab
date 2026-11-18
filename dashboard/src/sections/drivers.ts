// Risk drivers: current conditions, the model's industry (catastrophe) shock, and every exported driver series
// as small multiples grouped by theme, with a crosshair shared across the page.
import type { AppData, DriverInfo, Num } from "../types";
import type { Store } from "../state";
import { card, el, legend, tiles, type Card, type Tile } from "../ui";
import { miniLine, perilColumns, shockChart, fmtSigma, type StackPart } from "../charts/driver-panels";
import { ensureStyle, ordinal } from "../charts/b-style";
import { quarterLabel } from "../format";

// ---------------------------------------------------------------- driver metadata
const SHORT: Record<string, string> = {
  ust10y: "10-year Treasury", ust2y: "2-year Treasury", ust5y: "5-year Treasury",
  breakeven10: "10-year breakeven inflation", nfci: "Financial conditions (NFCI)",
  ai_capex: "Hyperscaler capex", ai_capex_yoy: "Hyperscaler capex growth", ai_capex_to_ocf: "Capex vs operating cash flow",
  gpr: "Geopolitical Risk index", gpr_threats: "GPR: threats", gpr_acts: "GPR: acts",
  epu: "US economic policy uncertainty", brent: "Brent crude oil",
  cpi_yoy: "CPI inflation", med_cpi_yoy: "Medical care prices", auto_repair_cpi_yoy: "Auto repair prices",
  legal_ppi_yoy: "Law-office prices (litigation costs)",
  ppi_pc_yoy: "All P&C lines", ppi_liab_yoy: "General liability", ppi_comauto_yoy: "Commercial auto",
  ppi_cmp_yoy: "Commercial multiple peril", ppi_wc_yoy: "Workers' compensation", ppi_medmal_yoy: "Medical malpractice",
  ppi_home_yoy: "Homeowners",
  gdp_yoy: "Nominal GDP growth", real_gdp_yoy: "Real GDP growth", unrate: "Unemployment rate",
  recession: "Recession (NBER)", nonres_constr_yoy: "Nonresidential construction",
  billion_cost: "Billion-dollar disasters: cost", billion_count: "Billion-dollar disasters: events",
  fema_major: "FEMA major disaster declarations", global_temp: "Global temperature anomaly",
  cat_index: "Catastrophe activity index", storm_damage: "Storm damage",
  storm_damage_hurricane: "Hurricanes", storm_damage_convective: "Convective storms", storm_damage_wildfire: "Wildfire",
  storm_damage_flood: "Flood",
};

const UNIT: Record<string, string> = {
  ust10y: "% (quarter average)", ust2y: "% (quarter average)", ust5y: "% (quarter average)", breakeven10: "%",
  nfci: "index: 0 = average, above 0 = tighter",
  ai_capex: "$bn per quarter: Microsoft, Alphabet, Amazon, Meta", ai_capex_yoy: "% year over year",
  ai_capex_to_ocf: "% of their operating cash flow, four quarters",
  gpr: "index, 1985–2019 = 100", gpr_threats: "index", gpr_acts: "index", epu: "index", brent: "$ per barrel",
  cpi_yoy: "% year over year", med_cpi_yoy: "% year over year", auto_repair_cpi_yoy: "% year over year",
  legal_ppi_yoy: "% year over year",
  ppi_pc_yoy: "% y/y", ppi_liab_yoy: "% y/y", ppi_comauto_yoy: "% y/y", ppi_cmp_yoy: "% y/y", ppi_wc_yoy: "% y/y",
  ppi_medmal_yoy: "% y/y", ppi_home_yoy: "% y/y",
  gdp_yoy: "% year over year", real_gdp_yoy: "% year over year", unrate: "%", recession: "share of the quarter",
  nonres_constr_yoy: "% year over year",
  billion_cost: "$bn, CPI-adjusted, by start quarter (list ends 2024)", billion_count: "events starting in the quarter",
  fema_major: "declarations per quarter", global_temp: "°C vs the 1901–2000 average, 12 months",
  cat_index: "z-score of log storm damage and FEMA declarations",
};

const ZERO = new Set([
  "nfci", "ai_capex_yoy", "cpi_yoy", "med_cpi_yoy", "auto_repair_cpi_yoy", "legal_ppi_yoy", "ppi_pc_yoy", "ppi_liab_yoy",
  "ppi_comauto_yoy", "ppi_cmp_yoy", "ppi_wc_yoy", "ppi_medmal_yoy", "ppi_home_yoy", "gdp_yoy", "real_gdp_yoy",
  "nonres_constr_yoy", "cat_index", "global_temp", "breakeven10",
]);

function fmtFor(key: string): (v: number) => string {
  const sign = (v: number, d: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
  if (["ust10y", "ust2y", "ust5y", "breakeven10"].includes(key)) return (v) => `${v.toFixed(2)}%`;
  if (key === "nfci" || key === "cat_index") return (v) => sign(v, 2);
  if (key === "global_temp") return (v) => `${sign(v, 2)}°C`;
  if (key === "recession") return (v) => `${Math.round(v * 100)}%`;
  if (key === "ai_capex" || key === "billion_cost" || key.startsWith("storm_damage")) {
    return (v) => `$${v >= 10 ? v.toFixed(0) : v.toFixed(1)}bn`;
  }
  if (key === "brent") return (v) => `$${v.toFixed(0)}`;
  if (["gpr", "gpr_threats", "gpr_acts", "epu"].includes(key)) return (v) => v.toFixed(0);
  if (["fema_major", "billion_count"].includes(key)) return (v) => v.toFixed(0);
  if (["ai_capex_yoy", "ai_capex_to_ocf"].includes(key)) return (v) => `${v.toFixed(0)}%`;
  return (v) => `${v.toFixed(1)}%`;
}

function axisFmtFor(key: string): (v: number) => string {
  if (["ust10y", "ust2y", "ust5y", "breakeven10", "unrate"].includes(key)) return (v) => `${v}%`;
  if (key === "recession") return (v) => `${Math.round(v * 100)}%`;
  if (key === "ai_capex" || key === "billion_cost" || key === "brent") return (v) => `$${v}`;
  if (key === "global_temp") return (v) => `${v}°`;
  if (["gpr", "gpr_threats", "gpr_acts", "epu", "fema_major", "billion_count", "nfci", "cat_index"].includes(key)) {
    return (v) => String(v);
  }
  return (v) => `${v}%`;
}

const GROUPS: { name: string; title: string; sub: string; span: number; keys: string[] }[] = [
  {
    name: "Climate and catastrophes", title: "Climate and catastrophes", span: 12,
    sub: "Storm damage, billion-dollar disasters, federal disaster declarations and global temperature (NOAA NCEI, OpenFEMA)",
    keys: ["billion_cost", "billion_count", "fema_major", "global_temp", "cat_index"],
  },
  {
    name: "Geopolitics", title: "Geopolitics", span: 12,
    sub: "Caldara–Iacoviello Geopolitical Risk index (from newspaper coverage), US policy uncertainty, and oil",
    keys: ["gpr", "gpr_threats", "gpr_acts", "epu", "brent"],
  },
  {
    name: "Equities and the AI cycle", title: "The AI investment cycle", span: 6,
    sub: "Capital spending of the four largest cloud companies, from their own SEC filings",
    keys: ["ai_capex", "ai_capex_yoy", "ai_capex_to_ocf"],
  },
  {
    name: "Inflation and loss costs", title: "Inflation and loss costs", span: 6,
    sub: "Prices that drive what claims cost to settle",
    keys: ["cpi_yoy", "med_cpi_yoy", "auto_repair_cpi_yoy", "legal_ppi_yoy"],
  },
  {
    name: "Insurance pricing", title: "Insurance pricing by line", span: 12,
    sub: "Producer price indexes of US property-casualty insurers (BLS), change over a year",
    keys: ["ppi_pc_yoy", "ppi_liab_yoy", "ppi_comauto_yoy", "ppi_cmp_yoy", "ppi_wc_yoy", "ppi_medmal_yoy", "ppi_home_yoy"],
  },
  {
    name: "Rates and credit", title: "Rates and financial conditions", span: 12,
    sub: "Treasury yields set what new bond purchases earn; the Chicago Fed index tracks credit and market stress",
    keys: ["ust10y", "ust5y", "ust2y", "breakeven10", "nfci"],
  },
  {
    name: "Economy", title: "The economy insurers write against", span: 12,
    sub: "Payrolls, revenues and construction are the exposure base for most commercial premiums",
    keys: ["gdp_yoy", "real_gdp_yoy", "unrate", "recession", "nonres_constr_yoy"],
  },
];

const EVENTS: Record<string, { short: string; long: string }> = {
  "2017-09-30": { short: "Harvey, Irma, Maria", long: "hurricanes Harvey, Irma and Maria" },
  "2011-03-31": { short: "Tōhoku, Christchurch", long: "the Tōhoku and Christchurch earthquakes" },
  "2018-12-31": { short: "Camp Fire, Michael", long: "the Camp Fire and Hurricane Michael" },
  "2022-09-30": { short: "Ian", long: "Hurricane Ian" },
  "2012-12-31": { short: "Sandy", long: "Superstorm Sandy" },
  "2021-09-30": { short: "Ida", long: "Hurricane Ida" },
  "2025-03-31": { short: "LA wildfires", long: "the Los Angeles wildfires" },
  "2010-03-31": { short: "Chile quake", long: "the Chile earthquake" },
};

const CONDITIONS = [
  "gpr", "epu", "brent", "ai_capex_to_ocf", "ai_capex_yoy", "ust5y", "nfci", "cpi_yoy", "legal_ppi_yoy", "ppi_pc_yoy",
  "global_temp",
];

// ---------------------------------------------------------------- helpers
function lastComplete(data: AppData): number {
  const { quarters, partial } = data.macro;
  for (let i = quarters.length - 1; i >= 0; i--) if (!partial[i]) return i;
  return quarters.length - 1;
}

function keyRow(host: HTMLElement, partialLabel: string | null) {
  const box = el("div", { class: "b-keys" });
  const mk = (open: boolean, text: string) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("width", "12");
    s.setAttribute("height", "12");
    s.setAttribute("aria-hidden", "true");
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", "6");
    c.setAttribute("cy", "6");
    c.setAttribute("r", "4");
    c.style.fill = open ? "var(--surface)" : "var(--s1)";
    c.style.stroke = "var(--s1)";
    c.style.strokeWidth = "2";
    s.append(c);
    return el("span", { class: "b-k" }, s, el("span", { text }));
  };
  box.append(mk(false, "Latest complete quarter (value at the right)"));
  if (partialLabel) box.append(mk(true, `${partialLabel}: quarter to date`));
  host.append(box);
}

// ---------------------------------------------------------------- section
export function mountDrivers(host: HTMLElement, data: AppData, store: Store) {
  ensureStyle();
  const m = data.macro;
  const info = new Map<string, DriverInfo>(m.drivers.map((d) => [d.key, d]));
  const li = lastComplete(data);
  const partialI = m.partial.findIndex((p) => p);
  const partialLabel = partialI >= 0 ? quarterLabel(m.quarters[partialI]) : null;

  // ---- (c) current conditions
  const condHost = el("div", { class: "b-tiles" });
  host.append(el("p", {
    class: "b-lead",
    text: `Where things stand at the end of ${quarterLabel(m.quarters[li])}, and how unusual it is: the percentile of the `
      + "latest value among all quarters since the series began (2000 at the earliest).",
  }), condHost);
  const items: Tile[] = [];
  for (const key of CONDITIONS) {
    const vals = m.values[key];
    if (!vals || !info.has(key)) continue;
    let j = -1;
    for (let i = li; i >= 0; i--) if (vals[i] != null) { j = i; break; }
    if (j < 0) continue;
    const v = vals[j] as number;
    const hist = vals.slice(0, li + 1).filter((x): x is number => x != null);
    const firstI = vals.findIndex((x) => x != null);
    const p = Math.round((hist.filter((x) => x <= v).length / hist.length) * 100);
    items.push({
      label: SHORT[key] ?? info.get(key)!.label,
      value: fmtFor(key)(v),
      delta: `${ordinal(Math.max(1, Math.min(100, p)))} percentile since ${m.quarters[firstI].slice(0, 4)} · ${quarterLabel(m.quarters[j])}`,
      title: info.get(key)!.label,
    });
  }
  tiles(condHost, items);

  const grid = el("div", { class: "grid" });
  host.append(grid);

  // ---- (a) industry shock
  const sh = m.industryShock;
  const sc = card(grid, {
    title: "The industry shock: catastrophe quarters, found in the loss ratios",
    sub: "The common quarterly shock to all carriers' loss ratios, in standard deviations: posterior mean and 80% interval",
    span: 12, id: "industry-shock",
  });
  const redrawShock = shockChart({ card: sc, store, quarters: sh.quarters, mean: sh.mean, p10: sh.p10, p90: sh.p90, events: EVENTS, topN: 9 });
  sc.onRedraw(redrawShock);
  const ranked = sh.quarters.map((q, i) => ({ q, v: sh.mean[i] })).filter((d) => d.v != null)
    .sort((a, b) => (b.v as number) - (a.v as number));
  sc.caption.textContent = `Estimated jointly with the loss-ratio model from ${data.meta.panel.observations.toLocaleString("en-US")} `
    + `quarterly loss ratios of ${data.meta.panel.companies} carriers (${quarterLabel(data.meta.panel.first)} to `
    + `${quarterLabel(data.meta.panel.last)}). It is not an input: no catastrophe data goes into the model. The labels mark `
    + "the largest quarters that coincide with well-known catastrophes. Zero is an average quarter; the scenarios shift "
    + "this shock to represent heavier catastrophe seasons.";
  sc.setTable(() => ({
    columns: ["Quarter", "Shock (mean)", "80% interval, low", "80% interval, high", "Rank", "Coincides with"],
    rows: sh.quarters.map((q, i) => [quarterLabel(q), fmtSigma(sh.mean[i]), fmtSigma(sh.p10[i]), fmtSigma(sh.p90[i]),
      String(ranked.findIndex((r) => r.q === q) + 1), EVENTS[q]?.long ?? ""]).reverse(),
    caption: "Industry shock by quarter",
  }));

  // ---- (b) driver groups
  for (const grp of GROUPS) {
    const keys = grp.keys.filter((k) => m.values[k] && info.has(k));
    if (!keys.length) continue;
    const c: Card = card(grid, { title: grp.title, sub: grp.sub, span: grp.span, id: `drivers-${grp.keys[0]}` });
    keyRow(c.legend, partialLabel);
    const redraws: (() => void)[] = [];
    let tableKeys = [...keys];

    if (grp.name === "Climate and catastrophes") {
      tableKeys = ["storm_damage", "storm_damage_hurricane", "storm_damage_convective", "storm_damage_wildfire",
        "storm_damage_flood", ...keys].filter((k) => m.values[k]);
      const head = el("div", {},
        el("h4", { class: "b-wide-title", text: "Storm damage by peril, per year" }),
        el("p", { class: "b-unit", text: "Property damage recorded in NOAA Storm Events, $bn at today's prices" }));
      const lg = el("div", { class: "legend" });
      const chartHost = el("div", { class: "b-chart" });
      c.body.append(el("div", { class: "b-wide b-mini" }, head, lg, chartHost));
      const perils = storm(data);
      const parts: StackPart[] = [
        { key: "hurricane", label: "Hurricanes and tropical storms", color: "var(--s1)" },
        { key: "convective", label: "Hail, tornado, thunderstorm wind", color: "var(--s2)" },
        { key: "wildfire", label: "Wildfire", color: "var(--s3)" },
        { key: "flood", label: "Flood", color: "var(--s4, var(--b-s4))" },
        { key: "other", label: "Other", color: "var(--s5, var(--b-s5))" },
      ];
      legend(lg, parts.map((p) => ({ label: p.label, color: p.color, shape: "box" as const })));
      redraws.push(perilColumns({
        host: chartHost, store, years: perils.years, parts, values: perils.values, partialYear: perils.partialYear,
        fmt: (v) => `$${v >= 10 ? v.toFixed(0) : v.toFixed(1)}bn`, axisFmt: (v) => (v === 0 ? "$0" : `$${v}bn`),
        label: "Storm damage per year by peril", height: 220,
      }));
      const y24 = perils.years.indexOf(2024);
      const bd = billionByYear(data, 2024);
      if (y24 >= 0 && bd != null) {
        const total24 = parts.reduce((s, p) => s + (perils.values[p.key][y24] ?? 0), 0);
        c.caption.textContent = `Storm Events under-records the largest hurricanes: for 2024 it holds $${total24.toFixed(0)}bn `
          + `of property damage, against $${bd.toFixed(0)}bn in NOAA's billion-dollar estimates for events that began that `
          + "year. Read it as an activity measure, not an insured-loss total. NOAA stopped updating the billion-dollar list "
          + "after 2024; FEMA declarations and Storm Events continue."
          + (perils.partialYear ? ` ${perils.partialYear} is the year to date (lighter bar).` : "");
      }
    }
    if (grp.name === "Equities and the AI cycle") {
      c.caption.textContent = "Capex is each company's total capital expenditure (Amazon's includes logistics), from its "
        + "filings. Stock-index series (S&P 500, NASDAQ-100, VIX) are not used: their owners restrict redistribution.";
    }

    const minis = el("div", { class: "b-minis" });
    c.body.append(minis);
    for (const key of keys) {
      const d = info.get(key)!;
      const ch = el("div", { class: "b-chart" });
      minis.append(el("div", { class: "b-mini" },
        el("h4", { text: SHORT[key] ?? d.label }),
        el("p", { class: "b-unit", text: UNIT[key] ?? d.unit }),
        ch));
      redraws.push(miniLine({
        host: ch, store, quarters: m.quarters, values: m.values[key], partial: m.partial, name: SHORT[key] ?? d.label,
        label: `${d.label}, 2000 to ${quarterLabel(m.quarters[li])}`, fmt: fmtFor(key), axisFmt: axisFmtFor(key),
        zero: ZERO.has(key),
      }));
    }
    c.onRedraw(() => redraws.forEach((r) => r()));
    c.setTable(() => ({
      columns: ["Quarter", ...tableKeys.map((k) => SHORT[k] ?? info.get(k)?.label ?? k)],
      rows: m.quarters.map((q, i) => [
        quarterLabel(q) + (m.partial[i] ? " (to date)" : ""),
        ...tableKeys.map((k) => {
          const v = m.values[k]?.[i];
          return v == null ? "–" : fmtFor(k)(v as number);
        }),
      ]).reverse(),
      caption: grp.title,
    }));
  }
}

// ---------------------------------------------------------------- storm damage by peril and year
function storm(data: AppData): { years: number[]; values: Record<string, (number | null)[]>; partialYear?: number } {
  const m = data.macro;
  const v = m.values;
  const keyOf: Record<string, string> = {
    hurricane: "storm_damage_hurricane", convective: "storm_damage_convective", wildfire: "storm_damage_wildfire",
    flood: "storm_damage_flood",
  };
  const byYear = new Map<number, Record<string, number>>();
  let lastQ = "";
  m.quarters.forEach((q, i) => {
    const total = v.storm_damage?.[i];
    if (total == null) return;
    lastQ = q;
    const y = Number(q.slice(0, 4));
    const rec = byYear.get(y) ?? { total: 0, hurricane: 0, convective: 0, wildfire: 0, flood: 0 };
    rec.total += total as number;
    for (const [k, src] of Object.entries(keyOf)) rec[k] += (v[src]?.[i] as number | null) ?? 0;
    byYear.set(y, rec);
  });
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const values: Record<string, (number | null)[]> = { hurricane: [], convective: [], wildfire: [], flood: [], other: [] };
  for (const y of years) {
    const r = byYear.get(y)!;
    const named = r.hurricane + r.convective + r.wildfire + r.flood;
    values.hurricane.push(r.hurricane);
    values.convective.push(r.convective);
    values.wildfire.push(r.wildfire);
    values.flood.push(r.flood);
    values.other.push(Math.max(0, r.total - named));
  }
  const partialYear = lastQ && !lastQ.endsWith("-12-31") ? Number(lastQ.slice(0, 4)) : undefined;
  return { years, values, partialYear };
}

function billionByYear(data: AppData, year: number): number | null {
  const m = data.macro;
  const vals: Num[] = m.values.billion_cost ?? [];
  let s = 0;
  let n = 0;
  m.quarters.forEach((q, i) => {
    if (Number(q.slice(0, 4)) === year && vals[i] != null) {
      s += vals[i] as number;
      n++;
    }
  });
  return n ? s : null;
}
