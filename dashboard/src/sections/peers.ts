// Peer landscape: one metric, every carrier, four linked views (time lines, growth-vs-result scatter, heatmap,
// ranking). Hovering a company anywhere lights it up everywhere; the time crosshair drives the scatter and ranking.
import type { AppData } from "../types";
import type { MetricKey, Store } from "../state";
import { card, el, legend, segmented, selectControl } from "../ui";
import { METRIC, METRICS, SEGMENT_ORDER, SEGMENT_SHORT, displayName, medianSeries, series, visibleCompanies } from "../data";
import { lineChart, type LineSeries } from "../charts/lines";
import { scatterChart } from "../charts/scatter";
import { heatmapChart, heatLegend } from "../charts/heatmap";
import { rankBars } from "../charts/rankbars";
import { money, pct, quarterLabel } from "../format";

export function mountPeers(host: HTMLElement, data: AppData, store: Store) {
  const quarters = data.panel.quarters;
  const lastQ = quarters[quarters.length - 1];
  const specialtySegs = SEGMENT_ORDER.slice(0, 4);

  // the section's own filter row: metric and start year (scopes the four views below)
  const metricCtl = selectControl("Metric", METRICS.map((m) => ({ value: m.key, label: m.label })), store.get().metric,
    (v) => store.set({ metric: v as MetricKey }), "ctl-metric");
  const fromCtl = segmented("Since", [
    { value: "2010-03-31", label: "2010" }, { value: "2015-03-31", label: "2015" }, { value: "2020-03-31", label: "2020" },
  ], store.get().from, (v) => store.set({ from: v }));
  const help = el("p", { class: "sub", text: METRIC.get(store.get().metric)?.help ?? "" });
  host.append(el("div", { class: "controls" }, metricCtl.root, fromCtl.root), help);
  const grid = el("div", { class: "grid" });
  host.append(grid);

  const metric = () => METRIC.get(store.get().metric)!;
  const visible = () => visibleCompanies(data, store.get().segments, store.get().historical);
  const cohortCiks = (specialty: boolean) =>
    data.companies.filter((c) => c.comparable && specialtySegs.includes(c.segment) === specialty).map((c) => c.cik);
  const quarterFor = () => store.get().hoverQuarter ?? lastQ;

  // ---------------------------------------------------------------- lines over time
  const linesCard = card(grid, { title: "", span: 8, id: "peer-lines" });
  const lines = lineChart({
    card: linesCard, store, quarters, height: (w) => (w < 600 ? 300 : 380), label: "The metric over time for every carrier",
    fmt: (v) => metric().fmt(v), getFrom: () => store.get().from, selectable: true,
    getRef: () => (metric().ref !== undefined ? { value: metric().ref!, label: "100%: underwriting break-even" } : undefined),
    zeroLine: false,
    getSeries: () => {
      const m = metric().key;
      const s = store.get();
      const out: LineSeries[] = visible().filter((c) => c.cik !== s.selected).map((c) => ({
        id: String(c.cik), label: displayName(c), values: series(data, c.cik, m), role: "context",
      }));
      out.push({ id: "spec-median", label: "Specialty median", values: medianSeries(data, cohortCiks(true), m), role: "ref", color: "var(--s2)" });
      out.push({ id: "bench-median", label: "Benchmark median", values: medianSeries(data, cohortCiks(false), m), role: "ref", color: "var(--s3)" });
      const sel = data.byCik.get(s.selected);
      if (sel) out.push({ id: String(sel.cik), label: sel.ticker, values: series(data, sel.cik, m), role: "focus", color: "var(--s1)" });
      return out;
    },
  });
  const linesChrome = () => {
    const m = metric();
    const sel = data.byCik.get(store.get().selected);
    linesCard.setTitle(`${m.label}, every carrier`, `${visible().length} carriers shown · gray lines are peers · hover to identify, click to focus`);
    legend(linesCard.legend, [
      { label: sel ? displayName(sel) : "Selected", color: "var(--s1)" },
      { label: "Specialty median", color: "var(--s2)" },
      { label: "Standard-lines benchmark median", color: "var(--s3)" },
      { label: "Other carriers", color: "var(--context-strong)" },
    ]);
    linesCard.caption.textContent = "Medians use every comparable carrier filing in that quarter, including ones later acquired. "
      + "Trailing-four-quarter (TTM) ratios smooth seasonal catastrophe quarters.";
    linesCard.setTable(() => {
      const recent = quarters.slice(-8);
      return {
        columns: ["Company", ...recent.map(quarterLabel)],
        rows: visible().map((c) => [displayName(c), ...recent.map((q) => {
          const v = series(data, c.cik, m.key)[quarters.indexOf(q)];
          return v == null ? "–" : m.fmt(v);
        })]),
        caption: `${m.label} by quarter, last eight quarters`,
      };
    });
  };

  // ---------------------------------------------------------------- ranking at the crosshair quarter
  const rankCard = card(grid, { title: "", span: 4, id: "peer-rank" });
  const rank = rankBars({
    card: rankCard, store, label: "Ranking", fmt: (v) => metric().fmt(v),
    get ascending() { return metric().better !== "higher"; },
    getItems: () => {
      const i = quarters.indexOf(quarterFor());
      return visible().map((c) => ({
        id: c.cik, label: c.ticker, name: displayName(c),
        value: series(data, c.cik, metric().key)[i] as number,
        note: c.cohort === "benchmark" ? "Standard-lines benchmark" : SEGMENT_SHORT[c.segment],
      })).filter((d) => d.value != null);
    },
  } as Parameters<typeof rankBars>[0]);
  const rankChrome = () => {
    const q = quarterFor();
    const m = metric();
    rankCard.setTitle(`Ranking, ${quarterLabel(q)}`, m.better === "higher" ? "Highest first · follows the time crosshair" : "Lowest first · follows the time crosshair");
    rankCard.setTable(() => {
      const i = quarters.indexOf(q);
      const rows = visible().map((c) => ({ c, v: series(data, c.cik, m.key)[i] }))
        .filter((r) => r.v != null).sort((a, b) => (a.v as number) - (b.v as number));
      return { columns: ["Company", m.label], rows: rows.map((r) => [displayName(r.c), m.fmt(r.v as number)]) };
    });
  };

  // ---------------------------------------------------------------- growth vs result scatter
  const scatterCard = card(grid, { title: "", span: 6, id: "peer-scatter" });
  const scatterY = (): MetricKey => (store.get().metric === "npe_growth_yoy" ? "combined_ratio_ttm" : store.get().metric);
  const scatter = scatterChart({
    card: scatterCard, store, label: "Premium growth against the selected metric",
    xLabel: "Premium growth (TTM, y/y)",
    get yLabel() { return METRIC.get(scatterY())!.label; },
    xFmt: (v) => pct(v, 0), yFmt: (v) => METRIC.get(scatterY())!.fmt(v), sizeFmt: (v) => money(v),
    get yRef() { return METRIC.get(scatterY())!.ref !== undefined ? { value: 1, label: "100%" } : undefined; },
    xRef: { value: 0, label: "" },
    getQuarter: quarterFor,
    getPoints: (q) => {
      const i = quarters.indexOf(q);
      return visible().map((c) => ({
        id: c.cik, label: displayName(c), ticker: c.ticker,
        x: series(data, c.cik, "npe_growth_yoy")[i] as number,
        y: series(data, c.cik, scatterY())[i] as number,
        size: (series(data, c.cik, "npe_ttm")[i] as number) ?? 0,
        ring: c.cohort === "benchmark",
      })).filter((p) => p.x != null && p.y != null);
    },
  } as Parameters<typeof scatterChart>[0]);
  const scatterChrome = () => {
    const yk = METRIC.get(scatterY())!;
    scatterCard.setTitle(`Growth against ${yk.label.toLowerCase()}`, `Each dot a carrier, sized by premium · follows the time crosshair (${quarterLabel(quarterFor())})`);
    legend(scatterCard.legend, [
      { label: "Selected", color: "var(--s1)", shape: "dot" },
      { label: "Specialty carriers (filled)", color: "var(--context-strong)", shape: "dot" },
      { label: "Benchmark carriers (ring)", color: "transparent", shape: "dot" },
    ]);
    const ring = scatterCard.legend.querySelectorAll<HTMLElement>(".swatch-dot")[2];
    if (ring) ring.style.boxShadow = "inset 0 0 0 2px var(--context-strong)";
    scatterCard.setTable(() => {
      const i = quarters.indexOf(quarterFor());
      return {
        columns: ["Company", "Premium growth", yk.label, "Premium (TTM)"],
        rows: visible().filter((c) => series(data, c.cik, scatterY())[i] != null).map((c) => [displayName(c),
          pct(series(data, c.cik, "npe_growth_yoy")[i] as number, 1), yk.fmt(series(data, c.cik, scatterY())[i] as number),
          money(series(data, c.cik, "npe_ttm")[i] as number)]),
      };
    });
  };

  // ---------------------------------------------------------------- heatmap
  const heatCard = card(grid, { title: "", span: 6, id: "peer-heat" });
  const heatScale = (): { center?: number; span?: number; goodLow?: boolean } => {
    switch (metric().key) {
      case "combined_ratio_ttm": return { center: 1, span: 0.25, goodLow: true };
      case "pyd_ratio_ttm": return { center: 0, span: 0.12, goodLow: true };
      case "roe_ttm": case "bv_growth_yoy": return { center: 0.1, span: 0.2, goodLow: false };
      default: return {};
    }
  };
  const heat = heatmapChart({
    card: heatCard, store, label: "The metric by company and quarter", quarters, getFrom: () => store.get().from,
    fmt: (v) => metric().fmt(v), getScale: heatScale,
    getRows: () => visible()
      .sort((a, b) => SEGMENT_ORDER.indexOf(a.segment) - SEGMENT_ORDER.indexOf(b.segment) || a.ticker.localeCompare(b.ticker))
      .map((c) => ({ id: c.cik, label: c.ticker, name: displayName(c), group: c.segment, values: series(data, c.cik, metric().key) })),
  });
  const heatChrome = () => {
    const m = metric();
    const hs = heatScale();
    heatCard.setTitle(`${m.label} by quarter`, "Rows grouped by segment · the outlined row is the selected company");
    heatLegend(heatCard.legend, {
      center: hs.center, span: hs.span, goodLow: hs.goodLow, fmt: m.fmt,
      lowLabel: hs.center !== undefined ? `${m.fmt(hs.center - hs.span!)} or less` : "lower",
      highLabel: hs.center !== undefined ? `${m.fmt(hs.center + hs.span!)} or more` : "higher",
    });
    heatCard.setTable(() => ({
      columns: ["Company", ...quarters.slice(-12).map(quarterLabel)],
      rows: visible().map((c) => [displayName(c), ...quarters.slice(-12).map((q) => {
        const v = series(data, c.cik, m.key)[quarters.indexOf(q)];
        return v == null ? "–" : m.fmt(v);
      })]),
    }));
  };

  const chrome = () => { linesChrome(); rankChrome(); scatterChrome(); heatChrome(); };
  const redrawAll = () => { lines.redraw(); rank.redraw(); scatter.redraw(); heat.redraw(); };
  chrome();

  store.on(["metric"], (s) => {
    metricCtl.set(s.metric);
    help.textContent = METRIC.get(s.metric)?.help ?? "";
    chrome();
    redrawAll();
  });
  store.on(["from"], (s) => { fromCtl.set(s.from); heat.redraw(); lines.redraw(); });
  store.on(["segments", "historical", "selected"], () => { chrome(); redrawAll(); });
  // the crosshair quarter moves the ranking and the scatter (once per animation frame)
  let raf = 0;
  store.on(["hoverQuarter"], () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { rankChrome(); scatterChrome(); rank.redraw(); scatter.redraw(); });
  });
}
