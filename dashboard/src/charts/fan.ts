// Fan chart: an actual history line, then a forecast median with 50% and 90% bands, a comparison line
// (the baseline median) and a reference line. One crosshair tooltip reads every series at a quarter.
import { axisBottom } from "d3-axis";
import { area, line } from "d3-shape";
import { scaleLinear, scaleUtc } from "d3-scale";
import { pointer } from "d3-selection";
import { utcYear } from "d3-time";
import { utcFormat } from "d3-time-format";
import { hideTip, showTip, type TipRow } from "../ui";
import { nearestIndex, responsive, valueAxis } from "./common";

const fmtYear = utcFormat("%Y");

export interface FanPoint {
  date: Date;
  /** quantiles [p5, p25, p50, p75, p95] for forecast points */
  q?: number[];
  /** observed value for history points */
  value?: number | null;
  /** comparison line (baseline median), forecast points only */
  compare?: number | null;
}

export interface FanSpec {
  label: string;
  history: FanPoint[];
  forecast: FanPoint[];
  fmt: (v: number) => string;
  axisFmt?: (v: number) => string;
  ref?: { value: number; label: string };
  /** title + rows for the tooltip at point i of the combined history + forecast list */
  tip: (p: FanPoint, isForecast: boolean) => { title: string; rows: TipRow[]; note?: string };
  height?: number;
  /** extra domain values to include (e.g. 1.0 for the 100% line) */
  include?: number[];
}

export function drawFan(host: HTMLElement, getSpec: () => FanSpec | null): () => void {
  return responsive(host, {
    height: (w) => (w < 520 ? 250 : 320),
    margin: { top: 14, right: 18, bottom: 28, left: 52 },
    label: getSpec()?.label ?? "Forecast fan chart",
  }, (fr) => {
    const spec = getSpec();
    if (!spec) return;
    const all = [...spec.history, ...spec.forecast];
    if (!all.length) return;
    const dates = all.map((p) => p.date);
    const x = scaleUtc().domain([dates[0], dates[dates.length - 1]]).range([0, fr.width]);
    const vals: number[] = [...(spec.include ?? [])];
    for (const p of spec.history) if (p.value != null) vals.push(p.value);
    for (const p of spec.forecast) {
      if (p.q) vals.push(p.q[0], p.q[4]);
      if (p.compare != null) vals.push(p.compare);
    }
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || 0.05;
    lo -= pad;
    hi += pad;
    const y = scaleLinear().domain([lo, hi]).nice(5).range([fr.height, 0]);
    const g = fr.g;
    valueAxis(g, y, fr.width, spec.axisFmt ?? spec.fmt, fr.height < 260 ? 4 : 5);
    // one tick per calendar year (a quarterly span would otherwise repeat each year's label)
    const years = x.ticks(utcYear.every(1)!);
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${fr.height})`)
      .call(axisBottom(x).tickValues(years).tickFormat((d) => fmtYear(d as Date)).tickSizeOuter(0));

    // forecast region tint + divider at the jump-off
    if (spec.forecast.length && spec.history.length) {
      const x0 = x(spec.history[spec.history.length - 1].date);
      g.append("rect").attr("x", x0).attr("y", 0).attr("width", Math.max(0, fr.width - x0)).attr("height", fr.height)
        .style("fill", "var(--surface-2)").style("opacity", 0.55);
      g.append("line").attr("x1", x0).attr("x2", x0).attr("y1", 0).attr("y2", fr.height)
        .style("stroke", "var(--axis)").style("stroke-width", 1);
      g.append("text").attr("class", "label").attr("x", x0 + 6).attr("y", 12).text("Forecast");
    }

    if (spec.ref && spec.ref.value >= y.domain()[0] && spec.ref.value <= y.domain()[1]) {
      const ry = y(spec.ref.value);
      const ref = g.append("g").attr("class", "ref");
      ref.append("line").attr("x1", 0).attr("x2", fr.width).attr("y1", ry).attr("y2", ry);
      ref.append("text").attr("x", 4).attr("y", ry - 4).text(spec.ref.label);
    }

    // bands: start them at the last actual point so the fan grows out of the history line
    const last = spec.history.length ? spec.history[spec.history.length - 1] : null;
    const fc = spec.forecast.filter((p) => p.q);
    const bandPts = last && last.value != null
      ? [{ date: last.date, q: [last.value, last.value, last.value, last.value, last.value] }, ...fc]
      : fc;
    const band = (i0: number, i1: number) => area<FanPoint>()
      .x((p) => x(p.date)).y0((p) => y(p.q![i0])).y1((p) => y(p.q![i1]));
    g.append("path").datum(bandPts).attr("d", band(0, 4)).style("fill", "var(--band)");
    g.append("path").datum(bandPts).attr("d", band(1, 3)).style("fill", "var(--band-2)");

    // comparison (baseline median)
    const cmp = spec.forecast.filter((p) => p.compare != null);
    if (cmp.length) {
      const cmpPts = last && last.value != null ? [{ date: last.date, compare: last.value }, ...cmp] : cmp;
      g.append("path").datum(cmpPts as FanPoint[]).attr("class", "line")
        .attr("d", line<FanPoint>().x((p) => x(p.date)).y((p) => y(p.compare!)))
        .style("stroke", "var(--context-strong)");
    }

    // history
    const hist = line<FanPoint>().defined((p) => p.value != null).x((p) => x(p.date)).y((p) => y(p.value!));
    g.append("path").datum(spec.history).attr("class", "line").attr("d", hist).style("stroke", "var(--s1)");
    // forecast median
    g.append("path").datum(bandPts).attr("class", "line")
      .attr("d", line<FanPoint>().x((p) => x(p.date)).y((p) => y(p.q![2]))).style("stroke", "var(--s1)");
    // end markers
    if (last && last.value != null) {
      g.append("circle").attr("class", "dot").attr("cx", x(last.date)).attr("cy", y(last.value)).attr("r", 4.5)
        .style("fill", "var(--s1)");
    }
    const end = fc[fc.length - 1];
    if (end) {
      g.append("circle").attr("class", "dot").attr("cx", x(end.date)).attr("cy", y(end.q![2])).attr("r", 4.5)
        .style("fill", "var(--s1)");
      g.append("text").attr("class", "label strong").attr("x", Math.min(fr.width - 2, x(end.date) - 6))
        .attr("y", y(end.q![2]) - 10).attr("text-anchor", "end").text(spec.fmt(end.q![2]));
    }

    // crosshair
    const cross = g.append("g").attr("class", "crosshair").style("display", "none");
    cross.append("line").attr("y1", 0).attr("y2", fr.height);
    const focus = g.append("circle").attr("class", "dot").attr("r", 4.5).style("fill", "var(--s1)").style("display", "none");
    g.append("rect").attr("class", "hit").attr("width", fr.width).attr("height", fr.height)
      .on("pointermove", (ev: PointerEvent) => {
        const [mx] = pointer(ev);
        const i = nearestIndex(dates, x.invert(mx));
        const p = all[i];
        const isFc = i >= spec.history.length;
        const px = x(p.date);
        cross.style("display", null).attr("transform", `translate(${px},0)`);
        const v = isFc ? p.q?.[2] : p.value;
        if (v != null) focus.style("display", null).attr("cx", px).attr("cy", y(v));
        else focus.style("display", "none");
        const t = spec.tip(p, isFc);
        showTip(ev.clientX, ev.clientY, t.title, t.rows, t.note);
      })
      .on("pointerleave", () => {
        cross.style("display", "none");
        focus.style("display", "none");
        hideTip();
      });
  });
}
