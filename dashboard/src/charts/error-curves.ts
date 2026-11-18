// Small multi-series line chart over a discrete x (forecast horizon 1..8). End labels sit in the right margin with
// leader lines when they would collide; optional labeled reference lines (e.g. nominal interval coverage).
import { scaleLinear } from "d3-scale";
import { line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import { axisBottom } from "d3-axis";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive, valueAxis } from "./common";

export interface CurveSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  strong?: boolean;
}

export interface CurveOpts {
  card: Card;
  xs: number[];
  series: CurveSeries[];
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  xLabel: (x: number) => string;
  xAxisTitle: string;
  refs?: { value: number; label: string }[];
  domain?: [number, number];
  label: string;
  height?: number;
  rightMargin?: number;
}

export function curves(o: CurveOpts): () => void {
  return responsive(o.card.body, {
    height: o.height ?? 300, label: o.label,
    margin: { top: 14, right: o.rightMargin ?? 150, bottom: 40, left: 46 },
  }, (f) => {
    const x = scaleLinear().domain([o.xs[0], o.xs[o.xs.length - 1]]).range([0, f.width]);
    const vals = o.series.flatMap((s) => s.values).filter((v): v is number => v != null);
    for (const r of o.refs ?? []) vals.push(r.value);
    const dom = o.domain ?? [Math.min(...vals), Math.max(...vals)];
    const pad = (dom[1] - dom[0]) * 0.08 || 0.5;
    const y = scaleLinear().domain(o.domain ?? [Math.max(0, dom[0] - pad), dom[1] + pad]).range([f.height, 0]).nice(5);
    valueAxis(f.g, y, f.width, o.axisFmt ?? o.fmt, 5);
    f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
      .call(axisBottom(x).tickValues(o.xs).tickFormat((d) => String(d)).tickSizeOuter(0));
    f.g.append("text").attr("x", f.width / 2).attr("y", f.height + 34).attr("text-anchor", "middle").text(o.xAxisTitle);

    for (const r of o.refs ?? []) {
      const rg = f.g.append("g").attr("class", "ref");
      rg.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(r.value)).attr("y2", y(r.value));
    }
    const pathFor = (s: CurveSeries) =>
      d3line<number>().defined((i) => s.values[i] != null).x((i) => x(o.xs[i])).y((i) => y(s.values[i] as number))(
        o.xs.map((_, i) => i),
      ) ?? "";
    f.g.append("g").selectAll("path").data(o.series).join("path")
      .attr("class", "line").style("stroke", (s) => s.color).attr("d", pathFor);
    f.g.append("g").selectAll("circle")
      .data(o.series.flatMap((s) => s.values.map((v, i) => ({ s, v, i })).filter((d) => d.v != null)))
      .join("circle").attr("class", "dot").attr("r", 3.5)
      .attr("cx", (d) => x(o.xs[d.i])).attr("cy", (d) => y(d.v as number)).style("fill", (d) => d.s.color);

    // end labels: series ends and reference lines share the right margin; resolve collisions with leader lines
    type End = { y0: number; y: number; text: string; color?: string; strong?: boolean; ref?: boolean };
    const ends: End[] = [];
    for (const s of o.series) {
      let j = -1;
      for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) { j = i; break; }
      if (j < 0) continue;
      const yv = y(s.values[j] as number);
      ends.push({ y0: yv, y: yv, text: `${s.label} ${o.fmt(s.values[j] as number)}`, color: s.color, strong: s.strong });
    }
    for (const r of o.refs ?? []) ends.push({ y0: y(r.value), y: y(r.value), text: r.label, ref: true });
    ends.sort((a, b) => a.y0 - b.y0);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
    const overflow = ends.length ? ends[ends.length - 1].y - (f.height + 6) : 0;
    if (overflow > 0) for (const e of ends) e.y -= overflow;
    const lab = f.g.append("g");
    for (const e of ends) {
      if (Math.abs(e.y - e.y0) > 1.5) {
        lab.append("path").attr("class", "b-leader").style("fill", "none")
          .attr("d", `M${f.width + 3},${e.y0}L${f.width + 10},${e.y}L${f.width + 13},${e.y}`);
      }
      if (e.color) {
        lab.append("line").attr("x1", f.width + 14).attr("x2", f.width + 24).attr("y1", e.y).attr("y2", e.y)
          .style("stroke", e.color).style("stroke-width", 2);
      }
      lab.append("text").attr("class", e.strong ? "label strong" : "label").attr("x", f.width + (e.color ? 28 : 14))
        .attr("y", e.y).attr("dy", "0.32em").text(e.text);
    }

    const cross = f.g.append("g").attr("class", "crosshair").style("display", "none");
    const vline = cross.append("line").attr("y1", 0).attr("y2", f.height);
    f.g.append("rect").attr("class", "hit").attr("x", -10).attr("width", f.width + 20).attr("height", f.height)
      .on("pointermove", (ev: PointerEvent) => {
        const [px] = pointer(ev);
        const v = x.invert(px);
        let i = 0;
        for (let k = 1; k < o.xs.length; k++) if (Math.abs(o.xs[k] - v) < Math.abs(o.xs[i] - v)) i = k;
        cross.style("display", null);
        vline.attr("x1", x(o.xs[i])).attr("x2", x(o.xs[i]));
        showTip(ev.clientX, ev.clientY, o.xLabel(o.xs[i]),
          o.series.filter((s) => s.values[i] != null).map((s) => ({ color: s.color, name: s.label, value: o.fmt(s.values[i] as number), strong: s.strong })));
      })
      .on("pointerleave", () => {
        hideTip();
        cross.style("display", "none");
      });
  });
}
