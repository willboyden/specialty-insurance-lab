// Peer scatter for one fiscal year (the year the claims section reads): every carrier a dot sized by a dollar
// amount; the selected company in the accent, peers in gray, standard-lines benchmark carriers as rings. Hover links
// to every other view through the store, click selects.
import { scaleLinear, scaleSqrt } from "d3-scale";
import { Delaunay } from "d3-delaunay";
import { pointer } from "d3-selection";
import { axisBottom } from "d3-axis";
import type { Store } from "../state";
import type { Card, TipRow } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive, valueAxis } from "./common";

export interface ClaimsPoint {
  id: number;
  label: string;
  ticker: string;
  x: number;
  y: number;
  size: number;
  ring: boolean;
  rows?: TipRow[];
}

export interface ClaimsScatterOpts {
  card: Card;
  store: Store;
  label: string;
  xLabel: string;
  yLabel: string;
  xFmt: (v: number) => string;
  yFmt: (v: number) => string;
  watermark: () => string;
  getPoints: () => ClaimsPoint[];
  height?: number;
}

export function claimsScatter(o: ClaimsScatterOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: o.height ?? 340, label: o.label, margin: { bottom: 42, left: 52, right: 20 } }, (f) => {
      const pts = o.getPoints().filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      // robust domains: an extreme carrier (at most two per side) is left off the scale when its gap to the next
      // carrier is wider than the 10th-90th percentile spread of the rest; it then sits on the plot edge with its
      // value written beside it, so one outlier cannot squeeze every other carrier into a corner
      const fences = (vals: number[]): [number, number] => {
        const v = [...vals].sort((a, b) => a - b);
        if (!v.length) return [0, 1];
        let lo = 0;
        let hi = v.length - 1;
        const spread = () => {
          const q = (p: number) => v[lo + Math.round(p * (hi - lo))];
          return q(0.9) - q(0.1);
        };
        for (let k = 0; k < 2 && hi - lo > 4; k++) if (v[hi] - v[hi - 1] > spread()) hi--;
        for (let k = 0; k < 2 && hi - lo > 4; k++) if (v[lo + 1] - v[lo] > spread()) lo++;
        return [Math.min(0, v[lo]), v[hi] > v[lo] ? v[hi] : v[lo] + 1];
      };
      const [x0, x1] = fences(pts.map((p) => p.x));
      const [y0, y1] = fences(pts.map((p) => p.y));
      const x = scaleLinear().domain([x0, x1 + (x1 - x0) * 0.06]).range([0, f.width]).nice();
      const y = scaleLinear().domain([y0, y1 + (y1 - y0) * 0.06]).range([f.height, 0]).nice();
      const r = scaleSqrt().domain([0, Math.max(1, ...pts.map((p) => p.size))]).range([3.5, 16]);
      valueAxis(f.g, y, f.width, o.yFmt);
      f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
        .call(axisBottom(x).ticks(Math.max(3, Math.floor(f.width / 80))).tickFormat((d) => o.xFmt(Number(d))).tickSizeOuter(0));
      f.g.append("text").attr("x", f.width).attr("y", f.height + 36).attr("text-anchor", "end").text(o.xLabel);
      f.g.append("text").attr("x", 0).attr("y", -2).text(o.yLabel);
      f.g.append("text").attr("x", f.width - 4).attr("y", f.height - 8).attr("text-anchor", "end")
        .style("font-size", "28px").style("font-weight", "600").style("fill", "var(--grid)").text(o.watermark());
      const st = o.store.get();
      const cx = (p: ClaimsPoint) => Math.max(0, Math.min(f.width, x(p.x)));
      const cy = (p: ClaimsPoint) => Math.max(0, Math.min(f.height, y(p.y)));
      const order = [...pts].sort((a, b) => b.size - a.size);
      const dots = f.g.append("g").selectAll("circle").data(order).join("circle")
        .attr("cx", cx).attr("cy", cy).attr("r", (p) => r(p.size))
        .style("fill", (p) => (p.ring ? "transparent" : p.id === st.selected ? "var(--s1)" : "var(--context-strong)"))
        .style("fill-opacity", (p) => (p.id === st.selected ? 1 : 0.45))
        .style("stroke", (p) => (p.id === st.selected ? "var(--surface)" : p.ring ? "var(--context-strong)" : "var(--surface)"))
        .style("stroke-width", (p) => (p.ring ? 2 : 1.5));
      dots.filter((p) => p.id === st.selected).raise().style("fill", "var(--s1)").style("stroke-width", 2);
      const labels = f.g.append("g");
      const [dx0, dx1] = x.domain();
      const [dy0, dy1] = y.domain();
      const offScale = new Set<number>();
      for (const p of pts) {
        const offX = p.x > dx1 ? "→" : p.x < dx0 ? "←" : "";
        const offY = p.y > dy1 ? "↑" : p.y < dy0 ? "↓" : "";
        if (!offX && !offY) continue;
        const right = cx(p) > f.width - 90;
        labels.append("text").attr("class", "label halo").attr("text-anchor", right ? "end" : "start")
          .attr("x", cx(p) + (right ? -(r(p.size) + 4) : r(p.size) + 4)).attr("y", cy(p) + (offY === "↑" ? 10 : 0)).attr("dy", "0.32em")
          .attr("class", p.id === st.selected ? "label strong halo" : "label halo")
          .text(`${p.ticker} ${offY ? o.yFmt(p.y) : o.xFmt(p.x)} ${offX || offY}`);
        offScale.add(p.id);
      }
      const sel = pts.find((p) => p.id === st.selected);
      if (sel && !offScale.has(sel.id)) {
        labels.append("text").attr("class", "label strong halo").attr("x", cx(sel) + r(sel.size) + 4).attr("y", cy(sel)).attr("dy", "0.32em").text(sel.ticker);
      }
      const hoverLabel = labels.append("text").attr("class", "label halo");
      const delaunay = Delaunay.from(pts, cx, cy);
      const near = (mx: number, my: number) => {
        const p = pts[delaunay.find(mx, my)];
        return p && Math.hypot(cx(p) - mx, cy(p) - my) <= Math.max(22, r(p.size) + 8) ? p : null;
      };
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height).style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent) => {
          const [mx, my] = pointer(ev);
          const p = near(mx, my);
          if (!p) { hideTip(); hoverLabel.text(""); o.store.set({ hover: null }); return; }
          o.store.set({ hover: p.id });
          if (p.id !== st.selected) hoverLabel.attr("x", cx(p) + r(p.size) + 4).attr("y", cy(p)).attr("dy", "0.32em").text(p.ticker);
          showTip(ev.clientX, ev.clientY, p.label, [
            { name: o.yLabel, value: o.yFmt(p.y), strong: true },
            { name: o.xLabel, value: o.xFmt(p.x) },
            ...(p.rows ?? []),
          ], `${o.watermark()} · click to focus`);
        })
        .on("pointerleave", () => { hideTip(); hoverLabel.text(""); o.store.set({ hover: null }); })
        .on("click", (ev: PointerEvent) => {
          const p = near(...pointer(ev));
          if (p) o.store.set({ selected: p.id });
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
