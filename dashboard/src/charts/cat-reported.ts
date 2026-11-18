// One carrier's reported catastrophe losses as a share of its quarter's premiums (accent) against the model's
// catastrophe component, lambda x industry shock (comparison color), on one axis of loss-ratio points. The model
// line is a deviation from an average quarter (the shock is centered on zero), so compare the swings, not the level.
import { scaleLinear, scaleUtc } from "d3-scale";
import { line as d3line } from "d3-shape";
import { pointer } from "d3-selection";
import type { Num } from "../types";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { isoToDate, nearestIndex, responsive, timeAxis, valueAxis } from "./common";
import { money, pts, quarterLabel } from "../format";

export interface ReportedOpts {
  card: Card;
  store: Store;
  quarters: string[];
  ratio: Num[];
  usd: Num[];
  model: Num[] | null;
  basis: (string | null)[];
}

export function reportedChart(o: ReportedOpts): () => void {
  const dates = o.quarters.map(isoToDate);
  const draw = () => {
    if (o.card.showingTable() || !dates.length) return;
    responsive(o.card.body, { height: 260, label: "Reported catastrophe losses against the model's catastrophe component",
      margin: { top: 10, right: 16, bottom: 26, left: 52 } }, (f) => {
      const x = scaleUtc().domain([dates[0], dates[dates.length - 1]]).range([0, f.width]);
      const vals = [...o.ratio, ...(o.model ?? [])].filter((v): v is number => v != null);
      const y = scaleLinear().domain([Math.min(0, ...vals), Math.max(0.05, ...vals)]).range([f.height, 0]).nice();
      valueAxis(f.g, y, f.width, (v) => `${Math.round(v * 100)} pts`, 5);
      timeAxis(f.g, x, f.height, f.width);
      f.g.append("g").attr("class", "ref").append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(0)).attr("y2", y(0));
      const idx = dates.map((_, i) => i);
      const lineOf = (v: Num[]) => d3line<number>().defined((i) => v[i] != null).x((i) => x(dates[i])).y((i) => y(v[i] as number));
      if (o.model) f.g.append("path").attr("class", "line").style("stroke", "var(--s2)").attr("d", lineOf(o.model)(idx) ?? "");
      f.g.append("path").attr("class", "line").style("stroke", "var(--s1)").attr("d", lineOf(o.ratio)(idx) ?? "");
      f.g.selectAll("circle.rep").data(idx.filter((i) => o.ratio[i] != null)).join("circle").attr("class", "dot rep")
        .attr("r", 4).attr("cx", (i) => x(dates[i])).attr("cy", (i) => y(o.ratio[i] as number)).style("fill", "var(--s1)");
      const cross = f.g.append("g").attr("class", "crosshair").style("display", "none");
      const vline = cross.append("line").attr("y1", 0).attr("y2", f.height);
      const unsub = o.store.on(["hoverQuarter"], (st) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        const i = st.hoverQuarter ? o.quarters.indexOf(st.hoverQuarter) : -1;
        if (i < 0) { cross.style("display", "none"); return; }
        cross.style("display", null);
        vline.attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      });
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height)
        .on("pointermove", (ev: PointerEvent) => {
          const [px] = pointer(ev);
          const i = nearestIndex(dates, x.invert(px));
          o.store.set({ hoverQuarter: o.quarters[i] });
          showTip(ev.clientX, ev.clientY, quarterLabel(o.quarters[i]), [
            { color: "var(--s1)", name: "Reported, share of premiums", value: level(o.ratio[i]), strong: true },
            { name: "Reported, dollars", value: money(o.usd[i]) },
            { color: "var(--s2)", name: "Model: λ × industry shock", value: o.model?.[i] == null ? "–" : pts(o.model[i]) },
          ], o.basis[i] === "derived" ? "Fourth quarter derived: full year minus the first three quarters" : undefined);
        })
        .on("pointerleave", () => { hideTip(); cross.style("display", "none"); o.store.set({ hoverQuarter: null }); });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return draw;
}

/** a share of premiums as loss-ratio points, unsigned (a level, not a change) */
export function level(v: Num): string {
  return v == null || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(1)} pts`;
}
