// Charts for the risk-driver section:
//  miniLine      one driver, one 2px line, latest complete value labeled at the end, the quarter still running
//                as an open dot, crosshair shared with every other time chart through store.hoverQuarter
//  shockChart    the model's industry shock (posterior mean + 80% band) with the big quarters annotated
//  perilColumns  storm damage per year, stacked by peril, 2px surface gaps, 4px rounded data end
import { scaleBand, scaleLinear, scaleUtc } from "d3-scale";
import { area as d3area, line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import { axisBottom } from "d3-axis";
import type { Num } from "../types";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip, type TipRow } from "../ui";
import { isoToDate, nearestIndex, responsive, timeAxis, valueAxis } from "./common";
import { quarterLabel } from "../format";

// ---------------------------------------------------------------- one driver
export interface MiniLineOpts {
  host: HTMLElement;
  store: Store;
  quarters: string[];
  values: Num[];
  partial: boolean[];
  name: string; // for the tooltip
  label: string; // aria label
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  zero?: boolean;
  height?: number;
}

export function miniLine(o: MiniLineOpts): () => void {
  const dates = o.quarters.map(isoToDate);
  const complete = o.values.map((v, i) => (o.partial[i] ? null : v));
  let lastI = -1;
  for (let i = complete.length - 1; i >= 0; i--) if (complete[i] != null) { lastI = i; break; }
  let partialI = -1;
  for (let i = 0; i < o.values.length; i++) if (o.partial[i] && o.values[i] != null) partialI = i;
  let firstI = o.values.findIndex((v) => v != null);
  if (firstI < 0) firstI = 0;

  return responsive(o.host, { height: o.height ?? 132, label: o.label, margin: { top: 10, right: 58, bottom: 20, left: 38 } }, (f) => {
    const x = scaleUtc().domain([dates[firstI], dates[dates.length - 1]]).range([0, f.width]);
    const vals = o.values.filter((v): v is number => v != null && Number.isFinite(v));
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (o.zero && lo > 0 && lo < (hi - lo) * 0.6) lo = 0;
    if (o.zero && hi < 0) hi = 0;
    if (lo === hi) { lo -= 1; hi += 1; }
    const y = scaleLinear().domain([lo, hi]).range([f.height, 0]).nice(3);
    valueAxis(f.g, y, f.width, o.axisFmt ?? o.fmt, 3);
    timeAxis(f.g, x, f.height, f.width);
    if (o.zero && y.domain()[0] < 0 && y.domain()[1] > 0) {
      f.g.append("g").attr("class", "ref").append("line")
        .attr("x1", 0).attr("x2", f.width).attr("y1", y(0)).attr("y2", y(0));
    }
    const path = d3line<number>()
      .defined((i) => complete[i] != null && Number.isFinite(complete[i] as number))
      .x((i) => x(dates[i]))
      .y((i) => y(complete[i] as number));
    f.g.append("path").attr("class", "line").style("stroke", "var(--s1)")
      .attr("d", path(dates.map((_, i) => i)) ?? "");
    if (lastI >= 0) {
      const cx = x(dates[lastI]);
      const cy = y(complete[lastI] as number);
      f.g.append("circle").attr("class", "dot").attr("r", 4).attr("cx", cx).attr("cy", cy).style("fill", "var(--s1)");
      f.g.append("text").attr("class", "label strong").attr("x", f.width + 8).attr("y", cy).attr("dy", "0.32em")
        .text(o.fmt(complete[lastI] as number));
    }
    if (partialI >= 0) {
      f.g.append("circle").attr("class", "b-open").attr("r", 4)
        .attr("cx", x(dates[partialI])).attr("cy", y(o.values[partialI] as number)).style("stroke", "var(--s1)");
    }

    const cross = f.g.append("g").attr("class", "crosshair").style("display", "none");
    const vline = cross.append("line").attr("y1", 0).attr("y2", f.height);
    const cdot = cross.append("circle").attr("class", "dot").attr("r", 4).style("fill", "var(--s1)");
    const showAt = (i: number) => {
      const v = o.values[i];
      cross.style("display", null);
      vline.attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      if (v == null) cdot.style("display", "none");
      else cdot.style("display", null).attr("cx", x(dates[i])).attr("cy", y(v));
    };
    const unsub = o.store.on(["hoverQuarter"], (st) => {
      if (!f.svg.node()?.isConnected) { unsub(); return; }
      const i = st.hoverQuarter ? o.quarters.indexOf(st.hoverQuarter) : -1;
      if (i >= firstI) showAt(i);
      else cross.style("display", "none");
    });
    f.g.append("rect").attr("class", "hit").attr("x", -4).attr("width", f.width + 8).attr("height", f.height)
      .style("cursor", "crosshair")
      .on("pointermove", (ev: PointerEvent) => {
        const [px] = pointer(ev);
        const i = Math.max(firstI, nearestIndex(dates, x.invert(px)));
        o.store.set({ hoverQuarter: o.quarters[i] });
        showAt(i);
        const v = o.values[i];
        showTip(ev.clientX, ev.clientY, quarterLabel(o.quarters[i]),
          [{ color: "var(--s1)", name: o.name, value: v == null ? "no data" : o.fmt(v) }],
          o.partial[i] ? "Quarter to date" : undefined);
      })
      .on("pointerleave", () => {
        hideTip();
        cross.style("display", "none");
        o.store.set({ hoverQuarter: null });
      });
  });
}

// ---------------------------------------------------------------- industry shock
export interface ShockOpts {
  card: Card;
  store: Store;
  quarters: string[];
  mean: Num[];
  p10: Num[];
  p90: Num[];
  events: Record<string, { short: string; long: string }>;
  topN: number; // how many of the largest quarters are eligible for a label
}

export function shockChart(o: ShockOpts): () => void {
  const dates = o.quarters.map(isoToDate);
  const ranked = o.quarters
    .map((q, i) => ({ q, i, v: o.mean[i] }))
    .filter((d): d is { q: string; i: number; v: number } => d.v != null)
    .sort((a, b) => b.v - a.v);
  const rank = new Map(ranked.map((d, k) => [d.q, k + 1]));
  const eligible = ranked.slice(0, o.topN).filter((d) => o.events[d.q]);
  const ROW = 15;
  const ROWS = 3;

  return responsive(o.card.body, {
    height: (w) => (w < 640 ? 300 : 340), label: "Industry shock by quarter with the largest quarters annotated",
    margin: { top: ROW * ROWS + 12, right: 18, bottom: 28, left: 42 },
  }, (f) => {
    const x = scaleUtc().domain([dates[0], dates[dates.length - 1]]).range([0, f.width]);
    const all = [...o.p10, ...o.p90, ...o.mean].filter((v): v is number => v != null);
    const y = scaleLinear().domain([Math.min(0, ...all), Math.max(0, ...all)]).range([f.height, 0]).nice();
    valueAxis(f.g, y, f.width, (v) => (v > 0 ? "+" : "") + v.toFixed(0) + "σ", 5);
    timeAxis(f.g, x, f.height, f.width);
    f.g.append("g").attr("class", "ref").append("line")
      .attr("x1", 0).attr("x2", f.width).attr("y1", y(0)).attr("y2", y(0));
    const idx = dates.map((_, i) => i);
    const band = d3area<number>()
      .defined((i) => o.p10[i] != null && o.p90[i] != null)
      .x((i) => x(dates[i])).y0((i) => y(o.p10[i] as number)).y1((i) => y(o.p90[i] as number));
    f.g.append("path").attr("class", "b-band").style("fill", "var(--band)").attr("d", band(idx) ?? "");
    const ln = d3line<number>().defined((i) => o.mean[i] != null)
      .x((i) => x(dates[i])).y((i) => y(o.mean[i] as number));
    f.g.append("path").attr("class", "line").style("stroke", "var(--s1)").attr("d", ln(idx) ?? "");

    // annotations: measure each label, then place them greedily into ROWS rows above the plot
    const ann = f.g.append("g");
    const measured = eligible.map((d) => {
      const t = ann.append("text").attr("class", "b-annot").attr("text-anchor", "middle").text(o.events[d.q].short);
      const w = (t.node() as SVGTextElement).getComputedTextLength();
      return { ...d, t, w, px: x(dates[d.i]) };
    });
    const rows: { l: number; r: number }[][] = Array.from({ length: ROWS }, () => []);
    // place in order of size so the biggest quarters win the space
    for (const m of measured) {
      const half = m.w / 2;
      const cx = Math.min(Math.max(m.px, half), f.width - half);
      let row = -1;
      for (let r = 0; r < ROWS && row < 0; r++) {
        if (rows[r].every((b) => cx + half + 8 < b.l || cx - half - 8 > b.r)) row = r;
      }
      if (row < 0) { m.t.remove(); continue; }
      rows[row].push({ l: cx - half, r: cx + half });
      const ty = -f.margin.top + 10 + row * ROW + 4;
      m.t.attr("x", cx).attr("y", ty);
      ann.append("line").attr("class", "b-leader")
        .attr("x1", m.px).attr("x2", m.px).attr("y1", ty + 4).attr("y2", y(m.v) - 6);
      ann.append("circle").attr("class", "dot").attr("r", 4).attr("cx", m.px).attr("cy", y(m.v)).style("fill", "var(--s1)");
    }

    const cross = f.g.append("g").attr("class", "crosshair").style("display", "none");
    const vline = cross.append("line").attr("y1", 0).attr("y2", f.height);
    const cdot = cross.append("circle").attr("class", "dot").attr("r", 4).style("fill", "var(--s1)");
    const showAt = (i: number) => {
      cross.style("display", null);
      vline.attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      const v = o.mean[i];
      if (v == null) cdot.style("display", "none");
      else cdot.style("display", null).attr("cx", x(dates[i])).attr("cy", y(v));
    };
    const unsub = o.store.on(["hoverQuarter"], (st) => {
      if (!f.svg.node()?.isConnected) { unsub(); return; }
      const i = st.hoverQuarter ? o.quarters.indexOf(st.hoverQuarter) : -1;
      if (i >= 0) showAt(i);
      else cross.style("display", "none");
    });
    f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height).style("cursor", "crosshair")
      .on("pointermove", (ev: PointerEvent) => {
        const [px] = pointer(ev);
        const i = nearestIndex(dates, x.invert(px));
        const q = o.quarters[i];
        o.store.set({ hoverQuarter: q });
        showAt(i);
        const rows: TipRow[] = [
          { color: "var(--s1)", name: "Industry shock (posterior mean)", value: fmtSigma(o.mean[i]), strong: true },
          { name: "80% interval", value: `${fmtSigma(o.p10[i])} to ${fmtSigma(o.p90[i])}` },
        ];
        const ev2 = o.events[q];
        const r = rank.get(q);
        const note = [r ? `Rank ${r} of ${ranked.length} quarters` : "", ev2 ? `Coincides with ${ev2.long}` : ""]
          .filter(Boolean).join(" · ");
        showTip(ev.clientX, ev.clientY, quarterLabel(q), rows, note || undefined);
      })
      .on("pointerleave", () => {
        hideTip();
        cross.style("display", "none");
        o.store.set({ hoverQuarter: null });
      });
  });
}

export function fmtSigma(v: Num): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "σ";
}

// ---------------------------------------------------------------- stacked columns by year
export interface StackPart {
  key: string;
  label: string;
  color: string; // CSS color (var)
}

export interface ColumnsOpts {
  host: HTMLElement;
  store: Store;
  years: number[];
  parts: StackPart[];
  values: Record<string, (number | null)[]>; // part key -> value per year
  partialYear?: number; // drawn lighter, labeled "to date" in the tooltip
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  label: string;
  height?: number;
}

export function perilColumns(o: ColumnsOpts): () => void {
  return responsive(o.host, { height: o.height ?? 230, label: o.label, margin: { top: 10, right: 12, bottom: 24, left: 46 } }, (f) => {
    const x = scaleBand<number>().domain(o.years).range([0, f.width]).paddingInner(0.25).paddingOuter(0.1);
    const totals = o.years.map((_, i) => o.parts.reduce((s, p) => s + (o.values[p.key][i] ?? 0), 0));
    const y = scaleLinear().domain([0, Math.max(1, ...totals)]).range([f.height, 0]).nice(4);
    valueAxis(f.g, y, f.width, o.axisFmt ?? o.fmt, 4);
    const every = Math.max(1, Math.ceil(o.years.length / Math.max(2, Math.floor(f.width / 52))));
    f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
      .call(axisBottom(x).tickValues(o.years.filter((_, i) => i % every === 0)).tickFormat((d) => String(d)).tickSizeOuter(0));
    const bw = Math.min(24, x.bandwidth());
    const hot = f.g.append("rect").attr("class", "b-colhot").attr("y", 0).attr("height", f.height).style("display", "none");
    const bars = f.g.append("g");
    o.years.forEach((yr, i) => {
      const cx = (x(yr) ?? 0) + x.bandwidth() / 2;
      let acc = 0;
      const visible = o.parts.filter((p) => (o.values[p.key][i] ?? 0) > 0);
      visible.forEach((p, k) => {
        const v = o.values[p.key][i] ?? 0;
        const y0 = y(acc);
        const y1 = y(acc + v);
        acc += v;
        const top = k === visible.length - 1;
        // 2px surface gap between stacked segments: each segment gives up 1px at each joint
        const gapBottom = k === 0 ? 0 : 1;
        const gapTop = top ? 0 : 1;
        const h = Math.max(0, y0 - y1 - gapBottom - gapTop);
        if (h <= 0) return;
        const xl = cx - bw / 2;
        const yt = y1 + gapTop;
        const node = top ? bars.append("path").attr("d", roundedTop(xl, yt, bw, h, Math.min(4, h, bw / 2)))
          : bars.append("rect").attr("x", xl).attr("y", yt).attr("width", bw).attr("height", h);
        node.style("fill", p.color).style("opacity", o.partialYear === yr ? 0.55 : 1);
      });
    });
    const hoverYear = (yr: number | null) => {
      if (yr == null || !o.years.includes(yr)) { hot.style("display", "none"); return; }
      hot.style("display", null).attr("x", x(yr) ?? 0).attr("width", x.bandwidth());
    };
    const unsub = o.store.on(["hoverQuarter"], (st) => {
      if (!f.svg.node()?.isConnected) { unsub(); return; }
      hoverYear(st.hoverQuarter ? Number(st.hoverQuarter.slice(0, 4)) : null);
    });
    f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
      .on("pointermove", (ev: PointerEvent) => {
        const [px] = pointer(ev);
        const step = x.step();
        let k = Math.floor((px - (x(o.years[0]) ?? 0) + (step - x.bandwidth()) / 2) / step);
        k = Math.max(0, Math.min(o.years.length - 1, k));
        const yr = o.years[k];
        hoverYear(yr);
        o.store.set({ hoverQuarter: `${yr}-12-31` });
        const rows: TipRow[] = [...o.parts].reverse().map((p) => ({
          color: p.color, name: p.label, value: o.fmt(o.values[p.key][k] ?? 0),
        }));
        rows.unshift({ name: "Total", value: o.fmt(totals[k]), strong: true });
        showTip(ev.clientX, ev.clientY, o.partialYear === yr ? `${yr} (to date)` : String(yr), rows);
      })
      .on("pointerleave", () => {
        hideTip();
        hoverYear(null);
        o.store.set({ hoverQuarter: null });
      });
  });
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
