// One column per fiscal year for a single company: a value that diverges around zero (reserve development:
// favorable below zero in the diverging blue, adverse above in red), with a reference series (the segment median)
// as a line of dots. Columns are <= 24px wide, square at zero with a 4px rounded data end. Hover for values; click
// a year to make it the year the section's other views read (the chosen year is drawn at full opacity).
import { scaleBand, scaleLinear } from "d3-scale";
import { line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import type { Num } from "../types";
import type { Card, TipRow } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive, valueAxis } from "./common";

export interface DevBarsOpts {
  card: Card;
  label: string;
  years: number[];
  getValues: () => Num[];
  getMedian: () => Num[];
  getYear: () => number;
  onYear: (year: number) => void;
  fmt: (v: number) => string;
  axisFmt: (v: number) => string;
  names: () => { value: string; median: string };
  extraRows?: (i: number) => TipRow[];
  height?: number | ((w: number) => number);
}

/** Which year labels to draw: the chosen one always, then every k-th year, skipping any closer than minGap px to a
 *  label already placed (so the chosen year never collides with its neighbor). */
export function thinYearLabels(years: number[], center: (i: number) => number, minGap: number, chosen: number): number[] {
  const n = years.length;
  const span = n > 1 ? Math.abs(center(n - 1) - center(0)) / (n - 1) : minGap;
  const every = [1, 2, 4, 5, 10].find((k) => k * span >= minGap) ?? 10;
  const keep: number[] = chosen >= 0 ? [chosen] : [];
  for (let i = 0; i < n; i++) {
    if (i === chosen || years[i] % every !== 0) continue;
    if (keep.every((j) => Math.abs(center(j) - center(i)) >= minGap)) keep.push(i);
  }
  return keep.sort((a, b) => a - b);
}

export function colPath(x: number, w: number, y0: number, y1: number, r = 4): string {
  const h = Math.abs(y1 - y0);
  const rr = Math.min(r, w / 2, h);
  if (y1 < y0) return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
  return `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 - rr}V${y0}Z`;
}

export function devBars(o: DevBarsOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: o.height ?? 280, label: o.label, margin: { left: 50, right: 12, top: 16, bottom: 26 } }, (f) => {
      const vals = o.getValues();
      const med = o.getMedian();
      const n = o.years.length;
      const idx = Array.from({ length: n }, (_, i) => i);
      const x = scaleBand<number>().domain(idx).range([0, f.width]).paddingInner(0.3);
      let lo = 0;
      let hi = 0;
      for (const v of [...vals, ...med]) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (lo === 0 && hi === 0) { lo = -0.05; hi = 0.05; }
      const pad = (hi - lo) * 0.1;
      const y = scaleLinear().domain([lo - pad, hi + pad]).range([f.height, 0]).nice();
      valueAxis(f.g, y, f.width, o.axisFmt, 5);
      f.g.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(0)).attr("y2", y(0)).style("stroke", "var(--ink-3)");
      const bw = Math.min(24, x.bandwidth());
      const chosen = o.getYear();
      const bars = f.g.append("g");
      for (const i of idx) {
        const v = vals[i];
        if (v == null) continue;
        bars.append("path").attr("d", colPath(x(i)! + (x.bandwidth() - bw) / 2, bw, y(0), y(v)))
          .style("fill", v < 0 ? "var(--div-neg)" : "var(--div-pos)")
          .style("fill-opacity", o.years[i] === chosen ? 1 : 0.62);
      }
      // the chosen year: its value at the bar end
      const ci = o.years.indexOf(chosen);
      if (ci >= 0 && vals[ci] != null) {
        const v = vals[ci] as number;
        f.g.append("text").attr("class", "label strong halo").attr("text-anchor", "middle")
          .attr("x", x(ci)! + x.bandwidth() / 2).attr("y", v < 0 ? y(v) + 14 : y(v) - 6).text(o.fmt(v));
      }
      // reference series: a line with dots
      const line = d3line<number>().defined((i) => med[i] != null)
        .x((i) => x(i)! + x.bandwidth() / 2).y((i) => y(med[i] as number));
      f.g.append("path").attr("class", "line").style("stroke", "var(--s2)").attr("d", line(idx) ?? "");
      f.g.append("g").selectAll("circle").data(idx.filter((i) => med[i] != null)).join("circle")
        .attr("class", "dot").attr("r", 3.5).attr("cx", (i) => x(i)! + x.bandwidth() / 2).attr("cy", (i) => y(med[i] as number))
        .style("fill", "var(--s2)");
      // year labels, thinned to fit; the chosen year always shows
      const mid = (i: number) => x(i)! + x.bandwidth() / 2;
      f.g.append("g").attr("class", "axis").selectAll("text").data(thinYearLabels(o.years, mid, 34, ci))
        .join("text").attr("x", (i) => x(i)! + x.bandwidth() / 2).attr("y", f.height + 17).attr("text-anchor", "middle")
        .attr("class", (i) => (i === ci ? "label strong" : "")).text((i) => String(o.years[i]));
      // interaction: a full-height band per year
      const hover = f.g.append("rect").attr("y", -6).attr("height", f.height + 6).attr("width", x.step())
        .style("fill", "var(--ink)").style("fill-opacity", 0.05).style("display", "none").style("pointer-events", "none");
      const at = (mx: number) => Math.max(0, Math.min(n - 1, Math.floor((mx + (x.step() - x.bandwidth()) / 2) / x.step())));
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height).style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent) => {
          const i = at(pointer(ev)[0]);
          hover.style("display", null).attr("x", x(i)! - (x.step() - x.bandwidth()) / 2);
          const nm = o.names();
          const rows: TipRow[] = [
            { color: vals[i] != null && (vals[i] as number) < 0 ? "var(--div-neg)" : "var(--div-pos)", name: nm.value,
              value: vals[i] == null ? "no data" : o.fmt(vals[i] as number), strong: true },
            { color: "var(--s2)", name: nm.median, value: med[i] == null ? "–" : o.fmt(med[i] as number) },
            ...(o.extraRows?.(i) ?? []),
          ];
          showTip(ev.clientX, ev.clientY, `Fiscal ${o.years[i]}`, rows, o.years[i] === chosen ? undefined : "Click to read this year below");
        })
        .on("pointerleave", () => { hideTip(); hover.style("display", "none"); })
        .on("click", (ev: PointerEvent) => o.onYear(o.years[at(pointer(ev)[0])]));
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
