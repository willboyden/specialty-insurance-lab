// Growth vs profitability scatter at one quarter (the crosshair quarter, or the latest). Emphasis encoding:
// the focus company in the accent, peers in gray; standard-lines benchmark carriers as rings (shape, not color).
import { scaleLinear, scaleSqrt } from "d3-scale";
import { Delaunay } from "d3-delaunay";
import { pointer } from "d3-selection";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive, valueAxis } from "./common";
import { quarterLabel } from "../format";
import { axisBottom } from "d3-axis";

export interface ScatterPoint {
  id: number;
  label: string;
  ticker: string;
  x: number;
  y: number;
  size: number;
  ring: boolean;
}

export interface ScatterOpts {
  card: Card;
  store: Store;
  label: string;
  height?: number;
  xLabel: string;
  yLabel: string;
  xFmt: (v: number) => string;
  yFmt: (v: number) => string;
  sizeFmt: (v: number) => string;
  yRef?: { value: number; label: string };
  xRef?: { value: number; label: string };
  getPoints: (quarter: string) => ScatterPoint[];
  getQuarter: () => string;
}

export function scatterChart(o: ScatterOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: o.height ?? 360, label: o.label, margin: { bottom: 42, left: 52, right: 20 } }, (f) => {
      const q = o.getQuarter();
      const pts = o.getPoints(q).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      const qx = (arr: number[], p: number) => arr[Math.max(0, Math.min(arr.length - 1, Math.round(p * (arr.length - 1))))];
      const xs = pts.map((p) => p.x).sort((a, b) => a - b);
      const ys = pts.map((p) => p.y).sort((a, b) => a - b);
      let [x0, x1] = xs.length ? [qx(xs, 0.02), qx(xs, 0.98)] : [-0.1, 0.3];
      let [y0, y1] = ys.length ? [qx(ys, 0.02), qx(ys, 0.98)] : [0.8, 1.1];
      if (o.xRef) { x0 = Math.min(x0, o.xRef.value); x1 = Math.max(x1, o.xRef.value); }
      if (o.yRef) { y0 = Math.min(y0, o.yRef.value); y1 = Math.max(y1, o.yRef.value); }
      const px = (x1 - x0) * 0.08 || 0.05;
      const py = (y1 - y0) * 0.08 || 0.05;
      const x = scaleLinear().domain([x0 - px, x1 + px]).range([0, f.width]).nice();
      const y = scaleLinear().domain([y0 - py, y1 + py]).range([f.height, 0]).nice();
      const r = scaleSqrt().domain([0, Math.max(1, ...pts.map((p) => p.size))]).range([4, 18]);
      valueAxis(f.g, y, f.width, o.yFmt);
      f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
        .call(axisBottom(x).ticks(Math.max(3, Math.floor(f.width / 80))).tickFormat((d) => o.xFmt(Number(d))).tickSizeOuter(0));
      f.g.append("text").attr("x", f.width).attr("y", f.height + 36).attr("text-anchor", "end").text(o.xLabel);
      f.g.append("text").attr("x", 0).attr("y", -2).text(o.yLabel);
      const refs = f.g.append("g").attr("class", "ref");
      if (o.yRef) {
        refs.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(o.yRef.value)).attr("y2", y(o.yRef.value));
        refs.append("text").attr("x", f.width - 4).attr("y", y(o.yRef.value) - 5).attr("text-anchor", "end").text(o.yRef.label);
      }
      if (o.xRef) {
        refs.append("line").attr("y1", 0).attr("y2", f.height).attr("x1", x(o.xRef.value)).attr("x2", x(o.xRef.value));
      }
      // the quarter shown, large and quiet
      f.g.append("text").attr("x", f.width - 4).attr("y", f.height - 8).attr("text-anchor", "end")
        .style("font-size", "28px").style("font-weight", "600").style("fill", "var(--grid)").text(quarterLabel(q));

      const st = o.store.get();
      // outliers beyond the robust domain sit on the plot edge instead of leaving it
      const cx = (p: ScatterPoint) => Math.max(0, Math.min(f.width, x(p.x)));
      const cy = (p: ScatterPoint) => Math.max(0, Math.min(f.height, y(p.y)));
      const order = [...pts].sort((a, b) => b.size - a.size);
      const dots = f.g.append("g").selectAll("circle").data(order).join("circle")
        .attr("cx", cx).attr("cy", cy).attr("r", (p) => r(p.size))
        .style("fill", (p) => (p.ring ? "transparent" : p.id === st.selected ? "var(--s1)" : "var(--context-strong)"))
        .style("fill-opacity", (p) => (p.id === st.selected ? 1 : 0.45))
        .style("stroke", (p) => (p.id === st.selected ? "var(--s1)" : p.ring ? "var(--context-strong)" : "var(--surface)"))
        .style("stroke-width", (p) => (p.ring ? 2 : 1.5));
      dots.filter((p) => p.id === st.selected).raise().style("stroke", "var(--surface)").style("stroke-width", 2)
        .style("fill", "var(--s1)");
      const labels = f.g.append("g");
      const sel = pts.find((p) => p.id === st.selected);
      if (sel) labels.append("text").attr("class", "label strong").attr("x", cx(sel) + r(sel.size) + 4).attr("y", cy(sel)).attr("dy", "0.32em").text(sel.ticker);
      const hoverLabel = labels.append("text").attr("class", "label");

      const delaunay = Delaunay.from(pts, cx, cy);
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height).style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const i = delaunay.find(mx, my);
          const p = pts[i];
          if (!p || Math.hypot(cx(p) - mx, cy(p) - my) > Math.max(24, r(p.size) + 8)) {
            hideTip(); hoverLabel.text(""); o.store.set({ hover: null });
            return;
          }
          o.store.set({ hover: p.id });
          if (p.id !== st.selected) hoverLabel.attr("x", cx(p) + r(p.size) + 4).attr("y", cy(p)).attr("dy", "0.32em").text(p.ticker);
          showTip(ev.clientX, ev.clientY, p.label, [
            { name: o.yLabel, value: o.yFmt(p.y), strong: true },
            { name: o.xLabel, value: o.xFmt(p.x) },
            { name: "Net premiums earned (TTM)", value: o.sizeFmt(p.size) },
          ], `${quarterLabel(q)} · click to focus`);
        })
        .on("pointerleave", () => { hideTip(); hoverLabel.text(""); o.store.set({ hover: null }); })
        .on("click", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const p = pts[delaunay.find(mx, my)];
          if (p && Math.hypot(cx(p) - mx, cy(p) - my) <= Math.max(24, r(p.size) + 8)) o.store.set({ selected: p.id });
        });
      const unsub = o.store.on(["hover"], (s2) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        dots.style("fill-opacity", (p) => (p.id === s2.selected || p.id === s2.hover ? 1 : 0.45));
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
