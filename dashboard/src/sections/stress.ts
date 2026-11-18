// Stress lab: the scenario engine (src/engine.ts) run live in the browser, linked to the page's store.
import type { AppData, Company, ModelCompany, Scenario } from "../types";
import type { AppState, Store } from "../state";
import { card, el, legend, segmented, tiles, type TipRow } from "../ui";
import { count, money, num, pct, pts, quarterLabel, shortQuarter, signedPct } from "../format";
import { isoToDate } from "../charts/common";
import { weightedSeries } from "../data";
import * as E from "../engine";
import { drawFan, type FanPoint } from "../charts/fan";
import { drawDumbbell, type DumbbellRow } from "../charts/dumbbell";
import { drawContrib, type ContribPart } from "../charts/stress-contrib";
import { drawShockPanels, type ShockPanel } from "../charts/stress-shocks";

const PART_LABEL: Record<string, string> = {
  social: "Social inflation",
  inflation: "General inflation",
  geo: "Geopolitics",
  finstress: "Financial stress",
  f: "Catastrophes (industry shock)",
  overlays: "Assumption overlays",
};

const STYLE_ID = "stress-lab-style";

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.stress-filter { display: flex; flex-wrap: wrap; gap: 10px 20px; align-items: end; margin: 2px 0 12px; }
.stress-filter > .control:first-child { flex-basis: 100%; }
.stress-sev { display: flex; align-items: center; gap: 10px; min-height: 36px; }
.stress-sev input[type="range"] { width: 190px; accent-color: var(--s1); }
.stress-sev output { font-variant-numeric: tabular-nums; font-weight: 620; min-width: 3.2em; color: var(--ink); }
.stress-story { margin: 0 0 14px; }
.stress-story p { margin: 0 0 6px; }
.stress-story p:last-child { margin-bottom: 0; }
.stress-story .assume.off { opacity: 0.55; }
.stress-tiles { margin: 0 0 16px; }
.stress-empty { text-align: center; padding: 28px 8px; color: var(--ink-3); font-size: 13px; }
.stress-empty button { margin-top: 10px; }
@media (max-width: 640px) { .stress-sev input[type="range"] { width: 150px; } }
`;
  document.head.append(s);
}

interface YearStats {
  median: number;
  pOver: number;
}

function yearStats(sim: E.Sim, year: 1 | 2): YearStats {
  const v = E.yearCr(sim, year);
  let n = 0;
  for (const x of v) if (x > 1) n++;
  return { median: E.median(v), pOver: n / v.length };
}

function capStats(sim: E.Sim): { median: number; pNeg: number } {
  const last = E.column(sim.cap, sim.D, E.H - 1);
  let n = 0;
  for (const x of last) if (x < 0) n++;
  return { median: E.median(last), pNeg: n / last.length };
}

function notModeledReason(c: Company | undefined): string {
  if (!c) return "it is not in the universe";
  if (!c.comparable) return c.note ?? "its consolidated figures are not comparable";
  if (c.status !== "active") {
    return `it ${c.status === "acquired" ? "was acquired" : "stopped filing"}${c.statusYear ? ` in ${c.statusYear}` : ""}`;
  }
  return "it has too few quarters with a loss ratio, or no recent balance sheet";
}

const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");

/** loss-ratio points, with values that round to zero shown as an unsigned 0.0 */
function ptsClean(v: number): string {
  return Math.abs(v) < 0.0005 ? "0.0 pts" : pts(v);
}

export function mountStress(host: HTMLElement, data: AppData, store: Store) {
  injectStyle();
  const model = data.model;
  const modeled = new Map<number, ModelCompany>(model.companies.map((c) => [c.cik, c]));
  const specialtyCiks = model.companies.filter((c) => data.byCik.get(c.cik)?.cohort === "specialty").map((c) => c.cik);
  const horizon = model.horizon;
  const hDates = horizon.map(isoToDate);
  const yearRange = (y: 1 | 2) => `${shortQuarter(horizon[y === 1 ? 0 : 4])} – ${shortQuarter(horizon[y === 1 ? 3 : 7])}`;
  const scenarios = model.scenarios;
  const scenarioByKey = new Map<string, Scenario>(scenarios.map((s) => [s.key, s]));
  const validKey = (k: string) => (k === "baseline" || scenarioByKey.has(k) ? k : "baseline");
  if (validKey(store.get().scenario) !== store.get().scenario) store.set({ scenario: "baseline" });

  // ---------------------------------------------------------------- simulations (baseline once)
  const baseSims = E.runAll(model, { scenario: "baseline", severity: 0, overlays: false });
  const baseYear = { 1: new Map<number, YearStats>(), 2: new Map<number, YearStats>() };
  const baseCap = new Map<number, { median: number; pNeg: number }>();
  const baseCrQ = new Map<number, number[][]>();
  for (const [cik, s] of baseSims) {
    baseYear[1].set(cik, yearStats(s, 1));
    baseYear[2].set(cik, yearStats(s, 2));
    baseCap.set(cik, capStats(s));
    baseCrQ.set(cik, E.quantilesByQuarter(s.cr, s.D));
  }
  const baseAgg = E.peerAggregate(specialtyCiks.map((c) => baseSims.get(c)!));

  let scenSims = baseSims;
  let scenYear = baseYear;
  let scenCap = baseCap;
  let scenCrQ = baseCrQ;
  let scenAgg = baseAgg;
  let lastRunMs = 0;

  function recompute(st: AppState) {
    const key = validKey(st.scenario);
    if (key === "baseline" || st.severity === 0) {
      scenSims = baseSims;
      scenYear = baseYear;
      scenCap = baseCap;
      scenCrQ = baseCrQ;
      scenAgg = baseAgg;
      lastRunMs = 0;
      return;
    }
    const t0 = performance.now();
    scenSims = E.runAll(model, { scenario: key, severity: st.severity, overlays: st.overlays });
    scenYear = { 1: new Map(), 2: new Map() };
    scenCap = new Map();
    scenCrQ = new Map();
    for (const [cik, s] of scenSims) {
      scenYear[1].set(cik, yearStats(s, 1));
      scenYear[2].set(cik, yearStats(s, 2));
      scenCap.set(cik, capStats(s));
      scenCrQ.set(cik, E.quantilesByQuarter(s.cr, s.D));
    }
    scenAgg = E.peerAggregate(specialtyCiks.map((c) => scenSims.get(c)!));
    lastRunMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------- filter row (scopes this section)
  const s0 = store.get();
  const chipBox = el("div", { class: "chips", role: "group", "aria-label": "Scenario" });
  const chipFor = new Map<string, HTMLButtonElement>();
  for (const opt of [{ key: "baseline", name: "Baseline" }, ...scenarios.map((s) => ({ key: s.key, name: s.name }))]) {
    const b = el("button", {
      type: "button", class: "chip", "aria-pressed": String(validKey(s0.scenario) === opt.key), text: opt.name,
    });
    b.addEventListener("click", () => store.set({ scenario: opt.key }));
    chipFor.set(opt.key, b);
    chipBox.append(b);
  }
  const slider = el("input", {
    type: "range", min: 0, max: 2, step: 0.1, value: s0.severity, id: "stress-severity",
    "aria-describedby": "stress-severity-help",
  }) as HTMLInputElement;
  const sevOut = el("output", { for: "stress-severity", text: `×${s0.severity.toFixed(1)}` });
  let sevTimer = 0;
  slider.addEventListener("input", () => {
    const v = Math.round(Number(slider.value) * 10) / 10;
    sevOut.textContent = `×${v.toFixed(1)}`;
    slider.setAttribute("aria-valuetext", `${v.toFixed(1)} times the scenario`);
    window.clearTimeout(sevTimer);
    sevTimer = window.setTimeout(() => store.set({ severity: v }), 60);
  });
  const sevCtl = el("div", { class: "control" },
    el("label", { for: "stress-severity", text: "Severity" }),
    el("div", { class: "stress-sev" }, slider, sevOut),
    el("span", {
      id: "stress-severity-help", class: "sr-only",
      text: "Scales every shock and overlay of the scenario; 1 is the scenario as written, 0 is the baseline.",
    }));
  const ovBox = el("input", { type: "checkbox", id: "stress-overlays" }) as HTMLInputElement;
  ovBox.checked = s0.overlays;
  ovBox.addEventListener("change", () => store.set({ overlays: ovBox.checked }));
  const ovCtl = el("div", { class: "control" }, el("span", { class: "label", text: "Overlays" }),
    el("label", { class: "toggle", for: "stress-overlays" }, ovBox, "Include assumption overlays"));
  const yearCtl = segmented<number>("Forecast year", [
    { value: 1, label: `Year 1 (${yearRange(1)})` }, { value: 2, label: `Year 2 (${yearRange(2)})` },
  ], s0.year, (v) => store.set({ year: v === 2 ? 2 : 1 }));
  host.append(el("div", { class: "stress-filter", role: "region", "aria-label": "Scenario settings for the stress lab" },
    el("div", { class: "control" }, el("span", { class: "label", text: "Scenario" }), chipBox),
    sevCtl, ovCtl, yearCtl.root));

  const story = el("div", { class: "note stress-story", "aria-live": "polite" });
  host.append(story);

  // ---------------------------------------------------------------- where we start
  const tileHost = el("div", { class: "stress-tiles", role: "group", "aria-label": "Where the forecasts start" });
  host.append(tileHost);
  tiles(tileHost, startTiles(data));

  // ---------------------------------------------------------------- cards
  const grid = el("div", { class: "grid" });
  host.append(grid);
  const fanCard = card(grid, { title: "Combined ratio: actual and forecast", span: 8, id: "stress-fan" });
  const contribCard = card(grid, { title: "What moves it", span: 4, id: "stress-contrib" });
  const peerCard = card(grid, { title: "Every carrier's forecast year", span: 6, id: "stress-peers" });
  const capCard = card(grid, { title: "Capital generated over eight quarters", span: 6, id: "stress-capital" });
  const aggCard = card(grid, { title: "Specialty peer group, premium-weighted", span: 6, id: "stress-agg" });
  const shockCard = card(grid, { title: "The scenario's shocks", span: 6, id: "stress-shocks" });

  // ---------------------------------------------------------------- fan chart (selected company)
  const fanHost = el("div");
  const fanEmpty = el("div", { class: "stress-empty", hidden: true });
  fanCard.body.append(fanHost, fanEmpty);
  legend(fanCard.legend, [
    { label: "Actual, then the scenario median", color: "var(--s1)", shape: "line" },
    { label: "50% and 90% of simulations", color: "var(--band-2)", shape: "box" },
    { label: "Baseline median", color: "var(--context-strong)", shape: "line" },
  ]);
  fanCard.caption.textContent = `Quarterly combined ratio. Forecasts: ${model.draws} posterior draws of the `
    + "hierarchical model, each with its own driver path, industry shock and noise, from the last reported quarter.";

  function fanSpec() {
    const st = store.get();
    const mc = modeled.get(st.selected);
    if (!mc) return null;
    const company = data.byCik.get(st.selected)!;
    const qs = data.panel.quarters;
    const endIdx = qs.indexOf(model.end);
    const crSeries = (data.panel.series[String(mc.cik)]?.combined_ratio ?? []) as (number | null)[];
    const history: FanPoint[] = [];
    for (let i = Math.max(0, endIdx - 11); i <= endIdx; i++) history.push({ date: isoToDate(qs[i]), value: crSeries[i] ?? null });
    const q = scenCrQ.get(mc.cik)!;
    const b = baseCrQ.get(mc.cik)!;
    const sim = scenSims.get(mc.cik)!;
    const isBase = validKey(st.scenario) === "baseline" || st.severity === 0;
    const forecast: FanPoint[] = hDates.map((d, h) => ({
      date: d, q: [q[0][h], q[1][h], q[2][h], q[3][h], q[4][h]], compare: isBase ? null : b[2][h],
    }));
    const pOverQ = (h: number) => {
      let n = 0;
      for (let d = 0; d < sim.D; d++) if (sim.cr[d * E.H + h] > 1) n++;
      return n / sim.D;
    };
    return {
      label: `${company.name}: quarterly combined ratio, last 12 quarters and 8-quarter forecast`,
      history, forecast, fmt: (v: number) => pct(v), axisFmt: (v: number) => pct(v, 0),
      ref: { value: 1, label: "100%: break-even underwriting" }, include: [1],
      tip: (p: FanPoint, isFc: boolean) => {
        const iso = p.date.toISOString().slice(0, 10);
        if (!isFc) {
          return {
            title: `${quarterLabel(iso)} · actual`,
            rows: [{ color: "var(--s1)", name: company.ticker, value: p.value != null ? pct(p.value) : "not reported", strong: true }],
          };
        }
        const h = hDates.findIndex((d) => +d === +p.date);
        const rows: TipRow[] = [
          { color: "var(--s1)", name: "scenario median", value: pct(p.q![2]), strong: true },
          { name: "50% of simulations", value: `${pct(p.q![1])} – ${pct(p.q![3])}` },
          { name: "90% of simulations", value: `${pct(p.q![0])} – ${pct(p.q![4])}` },
        ];
        if (p.compare != null) rows.push({ color: "var(--context-strong)", name: "baseline median", value: pct(p.compare) });
        rows.push({ name: "chance above 100%", value: pct(pOverQ(h), 0) });
        return { title: `${quarterLabel(iso)} · forecast`, rows };
      },
    };
  }
  const redrawFan = drawFan(fanHost, fanSpec);
  fanCard.onRedraw(() => redrawFan());

  // ---------------------------------------------------------------- contributions
  const contribHost = el("div");
  const contribEmpty = el("div", { class: "stress-empty", hidden: true });
  contribCard.body.append(contribHost, contribEmpty);
  let contribRes: ReturnType<typeof E.contributions> | null = null;
  function computeContrib() {
    const st = store.get();
    const mc = modeled.get(st.selected);
    const key = validKey(st.scenario);
    contribRes = mc && key !== "baseline" && st.severity > 0
      ? E.contributions(model, mc, key, st.severity, st.overlays, st.year, baseSims.get(mc.cik))
      : null;
  }
  function contribSpec() {
    if (!contribRes) return null;
    const ovOn = store.get().overlays;
    const parts: ContribPart[] = contribRes.parts
      .filter((p) => p.key !== "overlays" || ovOn)
      .map((p) => ({ label: PART_LABEL[p.key] ?? p.label, value: Math.abs(p.delta) < 0.0005 ? 0 : p.delta }));
    return {
      label: "Change in the forecast year's combined ratio by component",
      parts, total: { label: "Total change", value: contribRes.total }, fmt: ptsClean,
    };
  }
  const redrawContrib = drawContrib(contribHost, contribSpec);
  contribCard.onRedraw(() => redrawContrib());
  contribCard.caption.textContent = "Exact split: each component is simulated alone with the same draws and noise; "
    + "year averages use the baseline's premium weights, so the bars add up to the total.";

  // ---------------------------------------------------------------- peer dumbbells
  const peerHost = el("div");
  peerCard.body.append(peerHost);
  legend(peerCard.legend, [
    { label: "Baseline median", color: "var(--context-strong)", shape: "dot" },
    { label: "Scenario median", color: "var(--s1)", shape: "dot" },
  ]);
  peerCard.caption.textContent = `Premium-weighted combined ratio of the forecast year, median of ${model.draws} `
    + "simulations. Right: chance it exceeds 100% under the scenario. Gray labels: standard-lines benchmark. "
    + "Click a row to focus that carrier.";
  const capHost = el("div");
  capCard.body.append(capHost);
  legend(capCard.legend, [
    { label: "Baseline median", color: "var(--context-strong)", shape: "dot" },
    { label: "Scenario median", color: "var(--s1)", shape: "dot" },
  ]);
  capCard.caption.textContent = "Net income plus other comprehensive income over eight quarters, as a share of "
    + "starting equity, before dividends and buybacks. Right: chance it is negative (capital lost).";

  const visibleModeled = () => {
    const segs = store.get().segments;
    return model.companies.filter((c) => {
      const co = data.byCik.get(c.cik);
      return co && segs.includes(co.segment);
    });
  };

  function peerRows(): DumbbellRow[] {
    const y = store.get().year;
    return visibleModeled().map((c) => {
      const co = data.byCik.get(c.cik)!;
      const a = baseYear[y].get(c.cik)!;
      const b = scenYear[y].get(c.cik)!;
      return {
        key: c.cik, label: co.ticker, muted: co.cohort !== "specialty", a: a.median, b: b.median,
        right: pct(b.pOver, 0),
        tip: () => ({
          title: `${co.name} (${co.ticker})`,
          rows: [
            { color: "var(--s1)", name: "scenario median", value: pct(b.median), strong: true },
            { color: "var(--context-strong)", name: "baseline median", value: pct(a.median) },
            { name: "change", value: pts(b.median - a.median) },
            { name: "chance above 100%, scenario", value: pct(b.pOver, 0) },
            { name: "chance above 100%, baseline", value: pct(a.pOver, 0) },
          ],
          note: co.segment,
        }),
      };
    }).sort((p, q) => (q.b ?? 0) - (p.b ?? 0));
  }

  function capRows(): DumbbellRow[] {
    return visibleModeled().map((c) => {
      const co = data.byCik.get(c.cik)!;
      const a = baseCap.get(c.cik)!;
      const b = scenCap.get(c.cik)!;
      return {
        key: c.cik, label: co.ticker, muted: co.cohort !== "specialty", a: a.median, b: b.median,
        right: pct(b.pNeg, 0),
        tip: () => ({
          title: `${co.name} (${co.ticker})`,
          rows: [
            { color: "var(--s1)", name: "scenario median", value: signedPct(b.median, 0), strong: true },
            { color: "var(--context-strong)", name: "baseline median", value: signedPct(a.median, 0) },
            { name: "difference", value: pts(b.median - a.median, 0) },
            { name: "chance of losing capital", value: pct(b.pNeg, 0) },
          ],
          note: `Starting equity ${money(modeled.get(c.cik)!.equity)}`,
        }),
      };
    }).sort((p, q) => (p.b ?? 0) - (q.b ?? 0));
  }

  const onHover = (k: number | null) => store.set({ hover: k });
  const onSelect = (k: number) => store.set({ selected: k });
  const peerDb = drawDumbbell(peerHost, () => ({
    label: "Forecast-year combined ratio by carrier, baseline and scenario",
    rows: peerRows(), fmt: (v: number) => pct(v, 0), ref: { value: 1, label: "100%" },
    rightHeader: "P > 100%", selected: store.get().selected, hover: store.get().hover, onHover, onSelect,
  }));
  const capDb = drawDumbbell(capHost, () => ({
    label: "Capital generated over eight quarters by carrier, baseline and scenario",
    rows: capRows(), fmt: (v: number) => signedPct(v, 0), ref: { value: 0, label: "0" },
    rightHeader: "P < 0", selected: store.get().selected, hover: store.get().hover, onHover, onSelect,
  }));
  peerCard.onRedraw(() => peerDb.redraw());
  capCard.onRedraw(() => capDb.redraw());

  // ---------------------------------------------------------------- peer aggregate fan
  const aggHost = el("div");
  aggCard.body.append(aggHost);
  legend(aggCard.legend, [
    { label: "Actual, then the scenario median", color: "var(--s1)", shape: "line" },
    { label: "50% and 90% of simulations", color: "var(--band-2)", shape: "box" },
    { label: "Baseline median", color: "var(--context-strong)", shape: "line" },
  ]);
  aggCard.caption.textContent = `All ${specialtyCiks.length} modeled specialty carriers, weighted by premium in every `
    + "simulation, so a shared catastrophe or market shock hits them together. History: weighted by trailing premium.";
  const aggHistory = weightedSeries(data, specialtyCiks, "combined_ratio");
  function aggSpec() {
    const st = store.get();
    const qs = data.panel.quarters;
    const endIdx = qs.indexOf(model.end);
    const history: FanPoint[] = [];
    for (let i = Math.max(0, endIdx - 11); i <= endIdx; i++) history.push({ date: isoToDate(qs[i]), value: aggHistory[i] ?? null });
    const q = scenAgg.quantiles;
    const isBase = validKey(st.scenario) === "baseline" || st.severity === 0;
    const forecast: FanPoint[] = hDates.map((d, h) => ({
      date: d, q: [q[0][h], q[1][h], q[2][h], q[3][h], q[4][h]], compare: isBase ? null : baseAgg.quantiles[2][h],
    }));
    return {
      label: "Specialty peer group combined ratio: history and forecast",
      history, forecast, fmt: (v: number) => pct(v), axisFmt: (v: number) => pct(v, 0),
      ref: { value: 1, label: "100%" }, include: [1],
      tip: (p: FanPoint, isFc: boolean) => {
        const iso = p.date.toISOString().slice(0, 10);
        if (!isFc) {
          return {
            title: `${quarterLabel(iso)} · actual`,
            rows: [{ color: "var(--s1)", name: "specialty peers", value: p.value != null ? pct(p.value) : "–", strong: true }],
          };
        }
        const rows: TipRow[] = [
          { color: "var(--s1)", name: "scenario median", value: pct(p.q![2]), strong: true },
          { name: "50% of simulations", value: `${pct(p.q![1])} – ${pct(p.q![3])}` },
          { name: "90% of simulations", value: `${pct(p.q![0])} – ${pct(p.q![4])}` },
        ];
        if (p.compare != null) rows.push({ color: "var(--context-strong)", name: "baseline median", value: pct(p.compare) });
        return { title: `${quarterLabel(iso)} · forecast`, rows };
      },
    };
  }
  const redrawAgg = drawFan(aggHost, aggSpec);
  aggCard.onRedraw(() => redrawAgg());

  // ---------------------------------------------------------------- shock panels
  const shockHost = el("div");
  const shockEmpty = el("div", {
    class: "stress-empty", hidden: true,
    text: "The baseline adds no shocks: every driver follows its own statistical path from the last quarter.",
  });
  shockCard.body.append(shockHost, shockEmpty);
  function shockPanels(): ShockPanel[] {
    const st = store.get();
    const s = scenarioByKey.get(validKey(st.scenario));
    if (!s) return [];
    const sev = st.severity;
    const n = s.natural;
    const scale = (v: number[]) => v.map((x) => x * sev);
    const ppFmt = (v: number) => `${sign(v)}${Math.abs(v).toFixed(1)} pp`;
    const list: ShockPanel[] = [
      { title: "Equity return, added per quarter", values: scale(n.equityRet), fmt: (v) => `${sign(v)}${Math.abs(v).toFixed(0)}%` },
      { title: "5-year Treasury yield shift", values: scale(n.ust5y), fmt: ppFmt },
      { title: "Financial conditions (NFCI)", values: scale(n.nfci), fmt: (v) => `${sign(v)}${Math.abs(v).toFixed(2)}` },
      { title: "Litigation-cost inflation", values: scale(n.legalPpiYoy), fmt: ppFmt },
      { title: "Geopolitical risk index", values: n.logGpr.map((x) => Math.expm1(x * sev) * 100), fmt: (v) => `${sign(v)}${Math.abs(v).toFixed(0)}%` },
      { title: "Premium growth", values: scale(n.growth), fmt: ppFmt },
      { title: "Industry (catastrophe) shock", values: scale(s.shock.f), fmt: (v) => `${sign(v)}${Math.abs(v).toFixed(1)} sd` },
    ];
    return list.filter((p) => p.values.some((v) => Math.abs(v) > 1e-9));
  }
  const redrawShocks = drawShockPanels(shockHost, () => ({
    label: "Scenario shock paths by quarter", panels: shockPanels(), quarters: horizon.map(shortQuarter),
  }));
  shockCard.onRedraw(() => redrawShocks());
  shockCard.caption.textContent = "Shocks are added to each driver's baseline path and scaled by the severity "
    + "setting. Each panel has its own scale.";

  // ---------------------------------------------------------------- tables (the accessible twin of each chart)
  function setTables() {
    const st = store.get();
    fanCard.setTable(() => {
      const spec = fanSpec();
      const mc = modeled.get(store.get().selected);
      if (!spec || !mc) return { columns: ["Quarter"], rows: [["This carrier is not in the forecast"]] };
      const sim = scenSims.get(mc.cik)!;
      const rows: (string | number)[][] = spec.history.map((p) =>
        [quarterLabel(p.date.toISOString().slice(0, 10)), p.value != null ? pct(p.value) : "–", "", "", "", "", ""]);
      spec.forecast.forEach((p, h) => {
        let n = 0;
        for (let d = 0; d < sim.D; d++) if (sim.cr[d * E.H + h] > 1) n++;
        rows.push([quarterLabel(horizon[h]), "", pct(p.q![2]), `${pct(p.q![1])} – ${pct(p.q![3])}`,
          `${pct(p.q![0])} – ${pct(p.q![4])}`, p.compare != null ? pct(p.compare) : "", pct(n / sim.D, 0)]);
      });
      return {
        columns: ["Quarter", "Actual", "Median", "50% range", "90% range", "Baseline median", "Chance > 100%"], rows,
        caption: "Quarterly combined ratio, actual and simulated",
      };
    });
    contribCard.setTable(() => {
      const spec = contribSpec();
      if (!spec) return { columns: ["Component", "Change"], rows: [["Pick a scenario and a modeled carrier", ""]] };
      return {
        columns: ["Component", `Change in the year-${st.year} combined ratio`],
        rows: [...spec.parts, spec.total].map((p) => [p.label, pts(p.value)]),
      };
    });
    peerCard.setTable(() => ({
      columns: ["Carrier", "Segment", "Baseline median", "Scenario median", "Change", "Chance > 100%"],
      rows: peerRows().map((r) => {
        const co = data.byCik.get(r.key)!;
        return [`${co.name} (${co.ticker})`, co.segment, pct(r.a), pct(r.b), pts((r.b ?? 0) - (r.a ?? 0)), r.right ?? ""];
      }),
      caption: `Forecast year ${st.year} combined ratio by carrier`,
    }));
    capCard.setTable(() => ({
      columns: ["Carrier", "Baseline median", "Scenario median", "Difference", "Chance < 0"],
      rows: capRows().map((r) => {
        const co = data.byCik.get(r.key)!;
        return [`${co.name} (${co.ticker})`, signedPct(r.a, 0), signedPct(r.b, 0), pts((r.b ?? 0) - (r.a ?? 0), 0), r.right ?? ""];
      }),
      caption: "Capital generated over eight quarters, share of starting equity",
    }));
    aggCard.setTable(() => {
      const spec = aggSpec();
      const rows: (string | number)[][] = spec.history.map((p) =>
        [quarterLabel(p.date.toISOString().slice(0, 10)), p.value != null ? pct(p.value) : "–", "", "", ""]);
      spec.forecast.forEach((p, h) => rows.push([quarterLabel(horizon[h]), "", pct(p.q![2]),
        `${pct(p.q![0])} – ${pct(p.q![4])}`, p.compare != null ? pct(p.compare) : ""]));
      return { columns: ["Quarter", "Actual", "Median", "90% range", "Baseline median"], rows };
    });
    shockCard.setTable(() => {
      const panels = shockPanels();
      if (!panels.length) return { columns: ["Quarter"], rows: [["No shocks in the baseline"]] };
      return {
        columns: ["Quarter", ...panels.map((p) => p.title)],
        rows: horizon.map((q, h) => [quarterLabel(q), ...panels.map((p) => p.fmt(p.values[h]))]),
      };
    });
  }

  // ---------------------------------------------------------------- text, titles, empty states, controls
  function updateText() {
    const st = store.get();
    const key = validKey(st.scenario);
    const s = scenarioByKey.get(key);
    const active = !!s && st.severity > 0;
    story.replaceChildren();
    if (!s) {
      story.append(el("p", {
        text: "Baseline: no added shocks. Rates follow a random walk from today's level; inflation, litigation costs, "
          + "geopolitical risk and financial conditions revert toward their history; the industry (catastrophe) shock "
          + "is drawn from the same quarter of past years. Pick a scenario to stress it.",
      }));
    } else {
      story.append(el("p", {}, el("strong", { text: `${s.name}. ` }), s.story));
      for (const o of s.overlays) {
        story.append(el("p", { class: `assume${st.overlays ? "" : " off"}` },
          el("strong", { text: `Overlay${st.overlays ? "" : " (switched off)"}: ${o.label}. ` }), o.basis));
      }
      if (st.severity === 0) story.append(el("p", { text: "At severity 0 every shock is zero: this is the baseline." }));
    }
    const mc = modeled.get(st.selected);
    const co = data.byCik.get(st.selected);
    const scenName = s ? `${s.name} ×${st.severity.toFixed(1)}` : "Baseline";
    fanCard.setTitle(`${co?.name ?? "Company"}: combined ratio, actual and forecast`,
      `${scenName}${active && lastRunMs >= 1 ? ` · ${model.companies.length} carriers re-simulated in ${num(lastRunMs, 0)} ms` : ""}`);
    contribCard.setTitle("What moves it", `${co?.ticker ?? ""} · change in the year-${st.year} combined ratio vs baseline`);
    peerCard.setTitle(`Every carrier's year ${st.year}`, `${scenName} · ${yearRange(st.year)}`);
    capCard.setTitle("Capital generated over eight quarters", scenName);
    aggCard.setTitle("Specialty peer group, premium-weighted", scenName);
    shockCard.setTitle("The scenario's shocks", s ? `${s.name} at severity ×${st.severity.toFixed(1)}` : "Baseline");

    fanHost.hidden = !mc;
    fanEmpty.hidden = !!mc;
    fanCard.legend.hidden = !mc || fanCard.showingTable();
    if (!mc) {
      const first = model.companies.find((c) => data.byCik.get(c.cik)?.cohort === "specialty") ?? model.companies[0];
      const fc = data.byCik.get(first.cik)!;
      const btn = el("button", { type: "button", class: "btn", text: `Show ${fc.name} instead` });
      btn.addEventListener("click", () => store.set({ selected: first.cik }));
      fanEmpty.replaceChildren(
        el("p", {
          text: `${co?.name ?? "This company"} is not in the forecast: ${notModeledReason(co)}. `
            + `The model covers ${count(model.companies.length)} active, comparable carriers.`,
        }), btn);
    }
    const noContrib = !contribRes;
    contribHost.hidden = noContrib;
    contribEmpty.hidden = !noContrib;
    contribEmpty.textContent = !mc ? "Pick a modeled carrier to see what drives its forecast."
      : "Pick a scenario, with a severity above 0, to see what moves the forecast.";
    shockHost.hidden = !active;
    shockEmpty.hidden = active;
    if (s && st.severity === 0) shockEmpty.textContent = "At severity 0 the scenario adds no shocks.";
    else shockEmpty.textContent = "The baseline adds no shocks: every driver follows its own statistical path from the last quarter.";

    chipFor.forEach((b, k) => b.setAttribute("aria-pressed", String(k === key)));
    slider.disabled = key === "baseline";
    if (Math.abs(Number(slider.value) - st.severity) > 1e-9) slider.value = String(st.severity);
    sevOut.textContent = key === "baseline" ? "–" : `×${st.severity.toFixed(1)}`;
    ovBox.checked = st.overlays;
    ovBox.disabled = !s || !s.overlays.length;
    yearCtl.set(st.year);
  }

  // ---------------------------------------------------------------- wiring
  const renderAll = () => {
    computeContrib();
    updateText();
    if (!fanHost.hidden) redrawFan();
    if (!contribHost.hidden) redrawContrib();
    peerDb.redraw();
    capDb.redraw();
    redrawAgg();
    if (!shockHost.hidden) redrawShocks();
    setTables();
  };
  recompute(store.get());
  renderAll();

  store.on(["scenario", "severity", "overlays"], (st) => {
    recompute(st);
    renderAll();
  });
  store.on(["year"], () => renderAll());
  store.on(["selected"], (st) => {
    computeContrib();
    updateText();
    if (!fanHost.hidden) redrawFan();
    if (!contribHost.hidden) redrawContrib();
    peerDb.highlight(st.selected, st.hover);
    capDb.highlight(st.selected, st.hover);
    setTables();
  });
  store.on(["hover"], (st) => {
    peerDb.highlight(st.selected, st.hover);
    capDb.highlight(st.selected, st.hover);
  });
  store.on(["segments"], () => {
    peerDb.redraw();
    capDb.redraw();
    setTables();
  });
}

// ---------------------------------------------------------------- jump-off tiles
function startTiles(data: AppData) {
  const m = data.macro;
  const model = data.model;
  let lastComplete = m.quarters.length - 1;
  for (let i = m.quarters.length - 1; i >= 0; i--) {
    if (!m.partial[i]) {
      lastComplete = i;
      break;
    }
  }
  const partialIdx = m.partial[m.quarters.length - 1] ? m.quarters.length - 1 : -1;
  const v = (key: string, i: number) => (i >= 0 ? m.values[key]?.[i] ?? null : null);
  const lastNonNull = (key: string) => {
    const arr = m.values[key] ?? [];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return { v: arr[i] as number, q: m.quarters[i] as string | null };
    return { v: null as number | null, q: null as string | null };
  };
  const qLast = quarterLabel(m.quarters[lastComplete]);
  const qtd = partialIdx >= 0 ? `${quarterLabel(m.quarters[partialIdx])} to date` : "";
  const from = Math.max(0, lastComplete - 5);
  let peak = -Infinity;
  let peakQ = "";
  for (let i = from; i <= lastComplete; i++) {
    const x = v("gpr", i);
    if (x != null && x > peak) {
      peak = x;
      peakQ = m.quarters[i];
    }
  }
  const gprNow = v("gpr", lastComplete);
  const capex = lastNonNull("ai_capex_to_ocf");
  const capexAmt = lastNonNull("ai_capex");
  const capexYoy = lastNonNull("ai_capex_yoy");
  const shock = m.industryShock;
  const lastShock = shock.mean.length ? shock.mean[shock.mean.length - 1] : null;
  const lastShockQ = shock.quarters.length ? shock.quarters[shock.quarters.length - 1] : null;
  const ust5yQtd = v("ust5y_end", partialIdx);
  const nfciQtd = v("nfci", partialIdx);
  const gprQtd = v("gpr", partialIdx);
  return [
    {
      label: `5-year Treasury, end of ${quarterLabel(model.end)}`, value: `${model.base.start.ust5y.toFixed(2)}%`,
      delta: ust5yQtd != null && qtd ? `${qtd}: ${ust5yQtd.toFixed(2)}%` : undefined,
      title: "Where reinvestment yields and bond marks start",
    },
    {
      label: `Financial conditions (NFCI), ${quarterLabel(model.end)}`, value: model.base.start.nfci.toFixed(2),
      delta: `0 = average, below 0 = looser${nfciQtd != null && qtd ? ` · ${qtd}: ${nfciQtd.toFixed(2)}` : ""}`,
    },
    {
      label: `Geopolitical risk index, ${qLast}`, value: num(gprNow, 0),
      delta: `${peakQ && gprNow != null && peak > gprNow ? `peak ${num(peak, 0)} in ${quarterLabel(peakQ)}` : "1985-2019 average = 100"}`
        + `${gprQtd != null && qtd ? ` · ${qtd}: ${num(gprQtd, 0)}` : ""}`,
    },
    {
      label: `AI capex / operating cash flow${capex.q ? `, ${quarterLabel(capex.q)}` : ""}`,
      value: capex.v != null ? `${num(capex.v, 0)}%` : "–",
      delta: capexAmt.v != null
        ? `${money(capexAmt.v * 1e9)} in the quarter${capexYoy.v != null ? `, ${signedPct(capexYoy.v / 100, 0)} y/y` : ""}`
        : undefined,
      title: "Microsoft, Alphabet, Amazon and Meta, trailing four quarters, from their SEC filings",
    },
    {
      label: `Industry shock${lastShockQ ? `, ${quarterLabel(lastShockQ)}` : ""}`,
      value: lastShock != null
        ? `${Math.abs(lastShock) < 0.05 ? "" : lastShock > 0 ? "+" : "−"}${num(Math.abs(lastShock), 1)} sd` : "–",
      delta: "0 = an average quarter, inferred from loss ratios",
    },
  ];
}
