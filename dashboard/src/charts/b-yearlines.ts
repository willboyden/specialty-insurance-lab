// Small multi-series chart over years (disclosure shares): 2px lines, the running year as open dots, a crosshair
// shared with the quarterly charts through store.hoverQuarter (a year maps to its fourth quarter).
import { scaleLinear } from "d3-scale";
import { line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import { axisBottom } from "d3-axis";
import type { Store } from "../state";
import { hideTip, showTip, type TipRow } from "../ui";
import { responsive, valueAxis } from "./common";

export interface YearSeries {
  label: string;
  color: string;
  values: (number | null)[];
  strong?: boolean;
}

export interface YearLinesOpts {
  host: HTMLElement;
  store: Store;
  years: number[];
  series: YearSeries[];
  partialYear?: number;
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  domain?: [number, number];
  label: string;
  height?: number;
  note?: (i: number) => string | undefined;
}

export function yearLines(o: YearLinesOpts): () => void {
  return responsive(o.host, { height: o.height ?? 132, label: o.label, margin: { top: 10, right: 44, bottom: 20, left: 38 } }, (f) => {
    const x = scaleLinear().domain([o.years[0], o.years[o.years.length - 1]]).range([0, f.width]);
    const vals = o.series.flatMap((s) => s.values).filter((v): v is number => v != null);
    const y = scaleLinear().domain(o.domain ?? [0, Math.max(0.01, ...vals)]).range([f.height, 0]).nice(3);
    valueAxis(f.g, y, f.width, o.axisFmt ?? o.fmt, 3);
    const ticks = o.years.filter((yr) => yr % (f.width < 220 ? 10 : 5) === 0);
    f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
      .call(axisBottom(x).tickValues(ticks).tickFormat((d) => String(d)).tickSizeOuter(0));
    const done = (i: number) => o.years[i] !== o.partialYear;
    for (const s of o.series) {
      const path = d3line<number>().defined((i) => s.values[i] != null && done(i))
        .x((i) => x(o.years[i])).y((i) => y(s.values[i] as number));
      f.g.append("path").attr("class", "line").style("stroke", s.color).attr("d", path(o.years.map((_, i) => i)) ?? "");
      const pi = o.partialYear != null ? o.years.indexOf(o.partialYear) : -1;
      if (pi >= 0 && s.values[pi] != null) {
        f.g.append("circle").attr("class", "b-open").attr("r", 3.5).attr("cx", x(o.years[pi])).attr("cy", y(s.values[pi] as number))
          .style("stroke", s.color);
      }
    }
    // end label for the first (headline) series: its latest complete-year value
    const head = o.series[0];
    if (head) {
      let j = -1;
      for (let i = head.values.length - 1; i >= 0; i--) if (head.values[i] != null && done(i)) { j = i; break; }
      if (j >= 0) {
        const cy = y(head.values[j] as number);
        f.g.append("circle").attr("class", "dot").attr("r", 4).attr("cx", x(o.years[j])).attr("cy", cy).style("fill", head.color);
        f.g.append("text").attr("class", "label strong").attr("x", f.width + 8).attr("y", cy).attr("dy", "0.32em")
          .text(o.fmt(head.values[j] as number));
      }
    }
    const cross = f.g.append("g").attr("class", "crosshair").style("display", "none");
    const vline = cross.append("line").attr("y1", 0).attr("y2", f.height);
    const dots = cross.append("g");
    const showAt = (i: number) => {
      cross.style("display", null);
      vline.attr("x1", x(o.years[i])).attr("x2", x(o.years[i]));
      dots.selectAll("circle").data(o.series.filter((s) => s.values[i] != null)).join("circle")
        .attr("class", "dot").attr("r", 4).attr("cx", x(o.years[i])).attr("cy", (s) => y(s.values[i] as number))
        .style("fill", (s) => s.color);
    };
    const unsub = o.store.on(["hoverQuarter"], (st) => {
      if (!f.svg.node()?.isConnected) { unsub(); return; }
      const i = st.hoverQuarter ? o.years.indexOf(Number(st.hoverQuarter.slice(0, 4))) : -1;
      if (i >= 0) showAt(i);
      else cross.style("display", "none");
    });
    f.g.append("rect").attr("class", "hit").attr("x", -6).attr("width", f.width + 12).attr("height", f.height)
      .style("cursor", "crosshair")
      .on("pointermove", (ev: PointerEvent) => {
        const [px] = pointer(ev);
        const i = Math.max(0, Math.min(o.years.length - 1, Math.round(x.invert(px)) - o.years[0]));
        o.store.set({ hoverQuarter: `${o.years[i]}-12-31` });
        showAt(i);
        const rows: TipRow[] = o.series.map((s) => ({
          color: s.color, name: s.label, value: s.values[i] == null ? "no filings" : o.fmt(s.values[i] as number), strong: s.strong,
        }));
        showTip(ev.clientX, ev.clientY, o.years[i] === o.partialYear ? `${o.years[i]} (to date)` : String(o.years[i]), rows, o.note?.(i));
      })
      .on("pointerleave", () => {
        hideTip();
        cross.style("display", "none");
        o.store.set({ hoverQuarter: null });
      });
  });
}
