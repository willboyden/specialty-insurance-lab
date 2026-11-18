// Backtest: rolling-origin accuracy of the loss-ratio model against naive forecasts, and interval calibration.
// Every number and every sentence that states a result is computed from backtest.json.
import type { AppData, BacktestHorizon } from "../types";
import type { Store } from "../state";
import { card, el, tiles, type Tile } from "../ui";
import { ensureStyle } from "../charts/b-style";
import { curves } from "../charts/error-curves";
import { count, quarterLabel } from "../format";

const ptsFmt = (v: number) => `${v.toFixed(2)} pts`;
const change = (a: number, b: number) => (a - b) / b; // model vs benchmark, negative = better

function rel(a: number | undefined, b: number | undefined): string {
  if (a == null || b == null) return "–";
  const c = change(a, b) * 100;
  return `${c < 0 ? "−" : "+"}${Math.abs(c).toFixed(0)}%`;
}

export function mountBacktest(host: HTMLElement, data: AppData, _store: Store) {
  ensureStyle();
  const b = data.backtest;
  if (!b) {
    host.append(el("p", { class: "empty", text: "The backtest has not been run for this build (python -m sil.model.backtest)." }));
    return;
  }
  const H = [...b.by_horizon].sort((p, q) => p.h - q.h);
  const y1 = b.annual.year1 ?? {};
  const y2 = b.annual.year2 ?? {};
  const first = b.origins[0];
  const last = b.origins[b.origins.length - 1];

  const tileHost = el("div", { class: "b-tiles" });
  host.append(tileHost);
  const items: Tile[] = [
    { label: "Forecasts scored", value: count(b.forecasts), delta: `${b.companies} carriers, quarterly loss ratios 1–8 quarters ahead` },
    { label: "Forecast origins", value: String(b.origins.length), delta: `Year-ends ${first.slice(0, 4)}–${last.slice(0, 4)}, refit each time` },
  ];
  if (y1.mae_model != null) {
    items.push({
      label: "Year-1 loss-ratio error (MAE)", value: ptsFmt(y1.mae_model),
      delta: `${rel(y1.mae_model, y1.mae_last4)} vs last four quarters · ${rel(y1.mae_model, y1.mae_average)} vs company average`,
      tone: y1.mae_model < Math.min(y1.mae_last4 ?? Infinity, y1.mae_average ?? Infinity) ? "down-good" : "",
    });
  }
  if (y2.mae_model != null) {
    items.push({
      label: "Year-2 loss-ratio error (MAE)", value: ptsFmt(y2.mae_model),
      delta: `${rel(y2.mae_model, y2.mae_last4)} vs last four quarters · ${rel(y2.mae_model, y2.mae_average)} vs company average`,
      tone: y2.mae_model < Math.min(y2.mae_last4 ?? Infinity, y2.mae_average ?? Infinity) ? "down-good" : "",
    });
  }
  tiles(tileHost, items);

  const grid = el("div", { class: "grid" });
  host.append(grid);

  // ---- MAE by horizon
  const ec = card(grid, {
    title: "Forecast error by horizon",
    sub: "Mean absolute error of the quarterly loss ratio, in percentage points (lower is better)",
    span: 7, id: "backtest-mae",
  });
  const SER = [
    { key: "mae_model", label: "Model", color: "var(--s1)" },
    { key: "mae_model_known", label: "Model + realized drivers", color: "var(--s3)" },
    { key: "mae_last4", label: "Last four quarters", color: "var(--s2)" },
    { key: "mae_average", label: "Company average", color: "var(--context-strong)" },
  ] as const;
  const xs = H.map((h) => h.h);
  const val = (h: BacktestHorizon, k: (typeof SER)[number]["key"]) => (h[k] ?? null) as number | null;
  const series = SER.filter((s) => H.some((h) => val(h, s.key) != null))
    .map((s) => ({ key: s.key, label: s.label, color: s.color, strong: s.key === "mae_model", values: H.map((h) => val(h, s.key)) }));
  legendLines(ec.legend, series);
  ec.onRedraw(curves({
    card: ec, xs, series, fmt: (v) => v.toFixed(1), axisFmt: (v) => `${v}`, xLabel: (h) => `${h} quarter${h > 1 ? "s" : ""} ahead`,
    xAxisTitle: "Quarters ahead", label: "Forecast error by horizon for the model and three benchmarks", rightMargin: 196,
  }));
  ec.setTable(() => ({
    columns: ["Quarters ahead", "Forecasts", ...series.map((s) => `${s.label} (MAE, pts)`)],
    rows: H.map((h) => [String(h.h), String(h.n), ...series.map((s) => { const v = val(h, s.key); return v == null ? "–" : v.toFixed(2); })]),
    caption: "Mean absolute error by horizon",
  }));
  ec.caption.textContent = "Horizons 4 and 8 are fourth quarters (every origin is a year-end), when year-end reserve "
    + "reviews land; catastrophe quarters add their own spikes. Quarterly loss ratios are noisy: annual errors (tiles "
    + "above) are smaller because quarter-level noise partly cancels.";

  // ---- interval coverage
  const cc = card(grid, {
    title: "Are the forecast ranges honest?",
    sub: "How often the actual loss ratio fell inside the model's 80% and 50% ranges",
    span: 5, id: "backtest-coverage",
  });
  const cov = [
    { key: "cover80", label: "80% range", color: "var(--s1)", strong: true, values: H.map((h) => h.cover80) },
    { key: "cover50", label: "50% range", color: "var(--s2)", values: H.map((h) => h.cover50) },
  ];
  legendLines(cc.legend, cov);
  cc.onRedraw(curves({
    card: cc, xs, series: cov, fmt: (v) => `${Math.round(v * 100)}%`, axisFmt: (v) => `${Math.round(v * 100)}%`,
    xLabel: (h) => `${h} quarter${h > 1 ? "s" : ""} ahead`, xAxisTitle: "Quarters ahead",
    refs: [{ value: 0.8, label: "target 80%" }, { value: 0.5, label: "target 50%" }], domain: [0.3, 1],
    label: "Share of outcomes inside the forecast ranges, by horizon", rightMargin: 128,
  }));
  cc.setTable(() => ({
    columns: ["Quarters ahead", "Inside the 80% range", "Inside the 50% range"],
    rows: H.map((h) => [String(h.h), `${(h.cover80 * 100).toFixed(1)}%`, `${(h.cover50 * 100).toFixed(1)}%`]),
    caption: "Interval coverage by horizon",
  }));
  cc.caption.textContent = "A well-calibrated forecast lands on its target line: an 80% range should contain the outcome "
    + "about 80% of the time. Ranges include parameter uncertainty, the drawn catastrophe shock and company noise.";

  // ---- interpretation, computed from the numbers
  const prose = el("div", { class: "prose" });
  host.append(prose);
  prose.append(el("h3", { text: "What the backtest says" }));
  for (const p of interpret(b.forecasts, b.companies, b.origins, H, y1, y2)) prose.append(el("p", { text: p }));
}

function interpret(n: number, companies: number, origins: string[], H: BacktestHorizon[],
  y1: Record<string, number>, y2: Record<string, number>): string[] {
  const out: string[] = [];
  const better = (m?: number, x?: number) => m != null && x != null && m < x;
  out.push(`${count(n)} out-of-sample forecasts for ${companies} carriers, from ${origins.length} origins `
    + `(${quarterLabel(origins[0])} to ${quarterLabel(origins[origins.length - 1])}). At each origin the drivers were `
    + "standardized and the model refit using only data available then.");
  if (y1.mae_model != null) {
    // name each comparison: better than / worse than / level with (within 1%)
    const cmp = (m: number, x?: number) => {
      if (x == null) return "–";
      const c = change(m, x);
      const word = Math.abs(c) < 0.01 ? "level with" : c < 0 ? "better than" : "worse than";
      return `${word} ${x.toFixed(2)} (${rel(m, x)})`;
    };
    const parts: string[] = [];
    let allBetter = true;
    for (const [label, y] of [["the next four quarters", y1], ["the four after that", y2]] as const) {
      if (y.mae_model == null) continue;
      allBetter = allBetter && better(y.mae_model, y.mae_last4) && better(y.mae_model, y.mae_average);
      parts.push(`for ${label} the model's average loss-ratio error is ${y.mae_model.toFixed(2)} points: `
        + `${cmp(y.mae_model, y.mae_last4)} for repeating the last four quarters, and ${cmp(y.mae_model, y.mae_average)} `
        + "for the company's own average");
    }
    out.push(`On annual loss ratios, ${parts.join("; ")}. ${allBetter
      ? "The gains are modest."
      : "The gains are modest and fade with the horizon: beyond a year, a carrier's own long-run average does as well "
        + "or better."}`);
  }
  if (y1.mae_model != null && y1.mae_model_known != null) {
    const helps = y1.mae_model_known < y1.mae_model;
    out.push(helps
      ? `Plugging in the drivers' realized values improves the year-1 error a little (${y1.mae_model_known.toFixed(2)} vs `
        + `${y1.mae_model.toFixed(2)} points), so the macro channels carry some signal.`
      : `Plugging in the drivers' realized values does not improve it (${y1.mae_model_known.toFixed(2)} vs `
        + `${y1.mae_model.toFixed(2)} points in year 1). The forecasting edge comes from partial pooling: each carrier's `
        + "long-run level and persistence, estimated with help from its segment. The macro drivers matter for the "
        + "what-if questions of the stress lab, not for predicting next year's loss ratio.");
  }
  const q4 = H.filter((h) => h.h % 4 === 0 && h.mae_model != null);
  const other = H.filter((h) => h.h % 4 !== 0 && h.mae_model != null);
  if (q4.length && other.length) {
    const a = q4.reduce((s, h) => s + (h.mae_model as number), 0) / q4.length;
    const o = other.reduce((s, h) => s + (h.mae_model as number), 0) / other.length;
    if (a > o) {
      out.push(`Errors are highest at horizons ${q4.map((h) => h.h).join(" and ")} (${a.toFixed(1)} vs ${o.toFixed(1)} points `
        + "on average elsewhere): those are fourth quarters, where year-end reserve reviews and the derived Q4 figure "
        + "(annual minus nine months) concentrate surprises.");
    }
  }
  const c80 = H.map((h) => h.cover80);
  const avg80 = c80.reduce((s, v) => s + v, 0) / c80.length;
  out.push(`The 80% ranges contained the outcome ${(avg80 * 100).toFixed(0)}% of the time on average (from `
    + `${(Math.min(...c80) * 100).toFixed(0)}% to ${(Math.max(...c80) * 100).toFixed(0)}% by horizon), so the stated `
    + `uncertainty is roughly right${avg80 < 0.75 ? ", if a little narrow" : avg80 > 0.85 ? ", if a little wide" : ""}. `
    + "Catastrophes enter as draws of the industry shock from the same quarter of past years: their distribution is "
    + "forecast, not their timing.");
  out.push("Caveat: company figures are the latest filed values, including restatements, rather than the values first "
    + "reported, which gives the backtest a small look-ahead advantage on restated quarters.");
  return out;
}

function legendLines(host: HTMLElement, items: { label: string; color: string }[]) {
  host.replaceChildren();
  for (const it of items) {
    const sw = el("span", { class: "swatch-line", "aria-hidden": "true" });
    sw.style.background = it.color;
    host.append(el("span", { class: "key" }, sw, el("span", { text: it.label })));
  }
}
