// Company scatter for the people section: optional log x, an optional y = x diagonal, references, dots sized by
// premium. Emphasis encoding as in the peer scatter: the focus company in the accent, peers gray. Hover lights a
// company up in every view (store.hover); click focuses it (store.selected).
import { scaleLinear, scaleLog, scaleSqrt } from "d3-scale";
import { Delaunay } from "d3-delaunay";
import { pointer } from "d3-selection";
import { axisBottom } from "d3-axis";
import type { Store } from "../state";
import type { Card, TipRow } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive, valueAxis } from "./common";

export interface PeoplePoint {
  id: number;
  ticker: string;
  name: string;
  x: number;
  y: number;
  size: number;
  tip: TipRow[];
}

export interface PeopleScatterOpts {
  card: Card;
  store: Store;
  label: string;
  xLabel: string;
  yLabel: string;
  xFmt: (v: number) => string;
  yFmt: (v: number) => string;
  xLog?: boolean;
  diagonal?: { label: string };
  yRef?: { value: number; label: string };
  xRef?: { value: number };
  corner?: () => string;
  height?: number;
  getPoints: () => PeoplePoint[];
}

export function peopleScatter(o: PeopleScatterOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: o.height ?? 340, label: o.label, margin: { bottom: 42, left: 54, right: 20 } }, (f) => {
      const pts = o.getPoints().filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (!o.xLog || p.x > 0));
      const xs = pts.map((p) => p.x).sort((a, b) => a - b);
      const ys = pts.map((p) => p.y).sort((a, b) => a - b);
      const q = (arr: number[], p: number) => arr[Math.max(0, Math.min(arr.length - 1, Math.round(p * (arr.length - 1))))];
      let [x0, x1] = xs.length ? [q(xs, 0.02), q(xs, 0.98)] : [0, 1];
      let [y0, y1] = ys.length ? [q(ys, 0.02), q(ys, 0.98)] : [0, 1];
      if (o.diagonal) { const lo = Math.min(x0, y0); const hi = Math.max(x1, y1); x0 = y0 = lo; x1 = y1 = hi; }
      if (o.xRef) { x0 = Math.min(x0, o.xRef.value); x1 = Math.max(x1, o.xRef.value); }
      if (o.yRef) { y0 = Math.min(y0, o.yRef.value); y1 = Math.max(y1, o.yRef.value); }
      const x = o.xLog
        ? scaleLog().domain([x0 / 1.3, x1 * 1.3]).range([0, f.width])
        : scaleLinear().domain([x0 - (x1 - x0) * 0.08, x1 + (x1 - x0) * 0.08]).range([0, f.width]).nice();
      const y = scaleLinear().domain([y0 - (y1 - y0) * 0.08 || y0 - 0.05, y1 + (y1 - y0) * 0.08 || y1 + 0.05]).range([f.height, 0]).nice();
      const r = scaleSqrt().domain([0, Math.max(1, ...pts.map((p) => p.size))]).range([4, 16]);
      valueAxis(f.g, y, f.width, o.yFmt);
      const xAxis = axisBottom(x).tickSizeOuter(0);
      if (o.xLog) {
        const ticks = (x.ticks() as number[]).filter((t) => {
          const m = t / 10 ** Math.floor(Math.log10(t));
          return [1, 2, 5].some((k) => Math.abs(m - k) < 1e-9);
        });
        const keep = f.width < 420 && ticks.length > 4
          ? ticks.filter((t) => Math.abs(t / 10 ** Math.floor(Math.log10(t)) - 2) > 1e-9)
          : ticks;
        xAxis.tickValues(keep).tickFormat((d) => o.xFmt(Number(d)));
      } else {
        xAxis.ticks(Math.max(3, Math.floor(f.width / 80))).tickFormat((d) => o.xFmt(Number(d)));
      }
      f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`).call(xAxis);
      f.g.append("text").attr("x", f.width).attr("y", f.height + 36).attr("text-anchor", "end").text(o.xLabel);
      f.g.append("text").attr("x", 0).attr("y", -2).text(o.yLabel);
      const refs = f.g.append("g").attr("class", "ref");
      if (o.diagonal) {
        const [d0, d1] = [Math.max(x.domain()[0], y.domain()[0]), Math.min(x.domain()[1], y.domain()[1])];
        refs.append("line").attr("x1", x(d0)).attr("y1", y(d0)).attr("x2", x(d1)).attr("y2", y(d1));
        refs.append("text").attr("class", "halo").attr("x", x(d1) - 4).attr("y", y(d1) + 14).attr("text-anchor", "end").text(o.diagonal.label);
      }
      if (o.yRef) {
        refs.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(o.yRef.value)).attr("y2", y(o.yRef.value));
        refs.append("text").attr("class", "halo").attr("x", f.width - 4).attr("y", y(o.yRef.value) - 5).attr("text-anchor", "end").text(o.yRef.label);
      }
      if (o.xRef) refs.append("line").attr("y1", 0).attr("y2", f.height).attr("x1", x(o.xRef.value)).attr("x2", x(o.xRef.value));
      if (o.corner) {
        f.g.append("text").attr("x", f.width - 4).attr("y", f.height - 8).attr("text-anchor", "end")
          .style("font-size", "26px").style("font-weight", "600").style("fill", "var(--grid)").text(o.corner());
      }
      const st = o.store.get();
      const cx = (p: PeoplePoint) => Math.max(0, Math.min(f.width, x(p.x)));
      const cy = (p: PeoplePoint) => Math.max(0, Math.min(f.height, y(p.y)));
      const order = [...pts].sort((a, b) => b.size - a.size);
      const dots = f.g.append("g").selectAll("circle").data(order).join("circle")
        .attr("cx", cx).attr("cy", cy).attr("r", (p) => r(p.size))
        .style("fill", (p) => (p.id === st.selected ? "var(--s1)" : "var(--context-strong)"))
        .style("fill-opacity", (p) => (p.id === st.selected ? 1 : 0.45))
        .style("stroke", "var(--surface)").style("stroke-width", 1.5);
      dots.filter((p) => p.id === st.selected).raise().style("stroke-width", 2);
      const labels = f.g.append("g");
      const sel = pts.find((p) => p.id === st.selected);
      if (sel) labels.append("text").attr("class", "label strong halo").attr("x", cx(sel) + r(sel.size) + 4).attr("y", cy(sel)).attr("dy", "0.32em").text(sel.ticker);
      const hoverLabel = labels.append("text").attr("class", "label halo");
      const delaunay = Delaunay.from(pts, cx, cy);
      const near = (mx: number, my: number) => {
        const p = pts[delaunay.find(mx, my)];
        return p && Math.hypot(cx(p) - mx, cy(p) - my) <= Math.max(24, r(p.size) + 8) ? p : null;
      };
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height).style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const p = near(mx, my);
          if (!p) { hideTip(); hoverLabel.text(""); o.store.set({ hover: null }); return; }
          o.store.set({ hover: p.id });
          if (p.id !== st.selected) hoverLabel.attr("x", cx(p) + r(p.size) + 4).attr("y", cy(p)).attr("dy", "0.32em").text(p.ticker);
          showTip(ev.clientX, ev.clientY, p.name, p.tip, "Click to focus this company");
        })
        .on("pointerleave", () => { hideTip(); hoverLabel.text(""); o.store.set({ hover: null }); })
        .on("click", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const p = near(mx, my);
          if (p) o.store.set({ selected: p.id });
        });
      const unsub = o.store.on(["hover"], (s2) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        dots.style("fill-opacity", (p) => (p.id === s2.selected || p.id === s2.hover ? 1 : 0.45));
        const h = pts.find((p) => p.id === s2.hover && p.id !== s2.selected);
        hoverLabel.text(h ? h.ticker : "").attr("x", h ? cx(h) + r(h.size) + 4 : 0).attr("y", h ? cy(h) : 0).attr("dy", "0.32em");
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
