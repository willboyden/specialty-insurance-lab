// Company x fiscal-year heatmap for one claims metric. Diverging around a center (reserve development: favorable
// in blue, adverse in red, gray at zero) or a one-hue ramp for metrics without a natural center. Rows are carriers
// grouped by segment; the selected company's row and the year the section reads are outlined. Hover links the row
// to every other view; a click selects that carrier and that year.
import { scaleBand, scaleDiverging, scaleSequential } from "d3-scale";
import { interpolateRgbBasis } from "d3-interpolate";
import { pointer } from "d3-selection";
import type { Num } from "../types";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { css, responsive } from "./common";
import { thinYearLabels } from "./claims-devbars";

export interface YearHeatRow {
  id: number;
  label: string;
  name: string;
  group: string;
  values: Num[];
}

export interface YearHeatOpts {
  card: Card;
  store: Store;
  label: string;
  years: number[];
  getRows: () => YearHeatRow[];
  fmt: (v: number) => string;
  metricName: () => string;
  getScale: () => { center?: number; span?: number; goodLow?: boolean };
  getYear: () => number;
  onYear: (year: number) => void;
}

export const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

export function yearHeat(o: YearHeatOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    const rows = o.getRows();
    const rowH = 14;
    const groups = new Set(rows.map((r) => r.group)).size;
    responsive(o.card.body, {
      height: () => rows.length * rowH + groups * 6 + 34, label: o.label, margin: { left: 54, right: 8, top: 20, bottom: 8 },
    }, (f) => {
      const n = o.years.length;
      const idx = Array.from({ length: n }, (_, i) => i);
      const x = scaleBand<number>().domain(idx).range([0, f.width]).paddingInner(0.08);
      const yPos = new Map<number, number>();
      let yy = 0;
      let prev = "";
      for (const r of rows) {
        if (prev && r.group !== prev) yy += 6;
        yPos.set(r.id, yy);
        yy += rowH;
        prev = r.group;
      }
      const sp = o.getScale();
      let color: (v: number) => string;
      if (sp.center !== undefined) {
        const span = sp.span ?? 0.1;
        const [loC, hiC] = sp.goodLow === false ? [css("--div-pos"), css("--div-neg")] : [css("--div-neg"), css("--div-pos")];
        const sc = scaleDiverging(interpolateRgbBasis([loC, css("--div-mid"), hiC])).domain([sp.center - span, sp.center, sp.center + span]).clamp(true);
        color = (v) => sc(v);
      } else {
        const vals = rows.flatMap((r) => r.values).filter((v): v is number => v != null).sort((a, b) => a - b);
        const lo = vals[Math.floor(0.03 * (vals.length - 1))] ?? 0;
        const hi = vals[Math.ceil(0.97 * (vals.length - 1))] ?? 1;
        const sc = scaleSequential(interpolateRgbBasis(SEQ)).domain([lo, hi]).clamp(true);
        color = (v) => sc(v);
      }
      const st = o.store.get();
      const chosen = o.years.indexOf(o.getYear());
      for (const r of rows) {
        const ry = yPos.get(r.id)!;
        f.g.append("g").attr("transform", `translate(0,${ry})`).selectAll("rect")
          .data(idx.filter((i) => r.values[i] != null)).join("rect")
          .attr("x", (i) => x(i)!).attr("width", x.bandwidth()).attr("height", rowH - 2).attr("rx", 1.5)
          .style("fill", (i) => color(r.values[i] as number));
        f.g.append("text").attr("x", -6).attr("y", ry + rowH / 2 - 1).attr("dy", "0.32em").attr("text-anchor", "end")
          .attr("class", r.id === st.selected ? "label strong" : "label").style("font-size", "10.5px").text(r.label);
      }
      // year labels on top, thinned to fit; the chosen year always shows
      f.g.append("g").selectAll("text").data(thinYearLabels(o.years, (i) => x(i)! + x.bandwidth() / 2, 32, chosen)).join("text")
        .attr("x", (i) => x(i)! + x.bandwidth() / 2).attr("y", -7).attr("text-anchor", "middle")
        .attr("class", (i) => (i === chosen ? "label strong" : "label")).style("font-size", "10.5px").text((i) => String(o.years[i]));
      if (chosen >= 0) {
        f.g.append("rect").attr("x", x(chosen)! - 1.5).attr("y", -2).attr("width", x.bandwidth() + 3).attr("height", yy + 2)
          .attr("rx", 2).style("fill", "none").style("stroke", "var(--ink-3)").style("stroke-width", 1);
      }
      const sel = yPos.get(st.selected);
      if (sel !== undefined) {
        f.g.append("rect").attr("x", -1).attr("y", sel - 1).attr("width", f.width + 2).attr("height", rowH)
          .attr("rx", 2).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 1.5);
      }
      const hoverRow = f.g.append("rect").attr("x", -1).attr("width", f.width + 2).attr("height", rowH).attr("rx", 2)
        .style("fill", "none").style("stroke", "var(--ink-3)").style("display", "none");
      const rowAt = (py: number) => rows.find((r) => py >= yPos.get(r.id)! && py < yPos.get(r.id)! + rowH) ?? null;
      const colAt = (px: number) => Math.max(0, Math.min(n - 1, Math.floor(px / x.step())));
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", yy).style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const r = rowAt(my);
          const i = colAt(mx);
          o.store.set({ hover: r ? r.id : null });
          if (!r) { hoverRow.style("display", "none"); hideTip(); return; }
          hoverRow.style("display", null).attr("y", yPos.get(r.id)! - 1);
          const v = r.values[i];
          showTip(ev.clientX, ev.clientY, r.name, [{ name: `${o.metricName()}, fiscal ${o.years[i]}`, value: v == null ? "no data" : o.fmt(v), strong: true }],
            "Click to focus this carrier and year");
        })
        .on("pointerleave", () => { hideTip(); hoverRow.style("display", "none"); o.store.set({ hover: null }); })
        .on("click", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const r = rowAt(my);
          const i = colAt(mx);
          if (r && r.values[i] != null) o.onYear(o.years[i]);
          if (r) o.store.set({ selected: r.id });
        });
      const unsub = o.store.on(["hover"], (s2) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        const ry = s2.hover != null ? yPos.get(s2.hover) : undefined;
        if (ry !== undefined) hoverRow.style("display", null).attr("y", ry - 1);
        else hoverRow.style("display", "none");
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
