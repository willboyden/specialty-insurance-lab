// What buyers paid against what the target earned: price-to-book at the deal price (y) against the target's
// trailing return on equity at announcement (x), one dot per deal colored by buyer group, dot area = implied
// equity value. A reference line marks book value (1.0x). Labels are placed greedily so they never collide.
import { scaleLinear, scaleSqrt } from "d3-scale";
import { Delaunay } from "d3-delaunay";
import { pointer } from "d3-selection";
import { axisBottom } from "d3-axis";
import type { MaDeal } from "../domains/ma";
import type { Store } from "../state";
import type { Card } from "../ui";
import { hideTip, showTip } from "../ui";
import { responsive, valueAxis } from "./common";
import { groupColor } from "./ma-style";
import { dealTip } from "./ma-timeline";
import { pct, times } from "../format";

export interface DealScatterOpts {
  card: Card;
  store: Store;
  label: string;
  getDeals: () => MaDeal[];
  canFocus: (cik: number) => boolean;
}

export function dealScatter(o: DealScatterOpts) {
  const draw = () => {
    if (o.card.showingTable()) return;
    responsive(o.card.body, { height: (w) => (w < 520 ? 300 : 340), label: o.label, margin: { bottom: 40, left: 46, right: 18, top: 14 } }, (f) => {
      const pts = o.getDeals().filter((d) => d.pb != null && d.roe != null);
      const xs = pts.map((d) => d.roe as number);
      const ys = pts.map((d) => d.pb as number);
      // keep the plot readable: a distressed outlier is pinned to the edge (its true value is in the tooltip)
      const xLo = Math.max(-0.3, Math.min(-0.05, ...xs));
      const xHi = Math.max(0.15, ...xs);
      const x = scaleLinear().domain([xLo, xHi + 0.02]).range([0, f.width]).nice();
      const y = scaleLinear().domain([Math.min(0.6, ...ys) - 0.1, Math.max(2, ...ys) + 0.15]).range([f.height, 0]).nice();
      const r = scaleSqrt().domain([0, Math.max(1, ...pts.map((d) => d.value ?? 0))]).range([4, 17]);
      valueAxis(f.g, y, f.width, (v) => times(v, 1));
      f.g.append("g").attr("class", "axis").attr("transform", `translate(0,${f.height})`)
        .call(axisBottom(x).ticks(Math.max(3, Math.floor(f.width / 80))).tickFormat((d) => pct(Number(d), 0)).tickSizeOuter(0));
      f.g.append("text").attr("x", f.width).attr("y", f.height + 34).attr("text-anchor", "end")
        .text(f.width < 420 ? "Target ROE, trailing four quarters" : "Target's return on equity, trailing four quarters at announcement");
      f.g.append("text").attr("x", 0).attr("y", -4).text("Price / book value per share");
      const ref = f.g.append("g").attr("class", "ref");
      ref.append("line").attr("x1", 0).attr("x2", f.width).attr("y1", y(1)).attr("y2", y(1));
      // at the left end: the deals cluster at positive returns on the right, where a label would collide
      ref.append("text").attr("x", 4).attr("y", y(1) - 5).attr("text-anchor", "start").text("book value");
      if (x.domain()[0] < 0) {
        ref.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", f.height).style("stroke-dasharray", "2 3");
      }
      const cx = (d: MaDeal) => Math.max(0, Math.min(f.width, x(d.roe as number)));
      const cy = (d: MaDeal) => Math.max(0, Math.min(f.height, y(d.pb as number)));
      const st = o.store.get();
      const order = [...pts].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      const dots = f.g.append("g").selectAll("circle").data(order).join("circle")
        .attr("cx", cx).attr("cy", cy).attr("r", (d) => r(d.value ?? 0))
        .style("fill", (d) => groupColor(d.group)).style("fill-opacity", 0.8)
        .style("stroke", "var(--surface)").style("stroke-width", 1.5);
      dots.filter((d) => d.cik === st.selected).raise().style("stroke", "var(--ink)").style("stroke-width", 2);
      // labels: biggest deals first, skipped when they would overlap one already placed
      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      const labels = f.g.append("g");
      const sel = pts.find((d) => d.cik === st.selected);
      for (const d of [...(sel ? [sel] : []), ...order.filter((p) => p !== sel)]) {
        const w = d.ticker.length * 6.6 + 4;
        const lx = cx(d) + r(d.value ?? 0) + 3;
        const box = { x0: lx, x1: lx + w, y0: cy(d) - 7, y1: cy(d) + 7 };
        if (box.x1 > f.width + 16) continue;
        if (placed.some((b) => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1))) continue;
        if (pts.some((p) => p !== d && Math.hypot(cx(p) - (lx + w / 2), cy(p) - cy(d)) < r(p.value ?? 0) + 4)) continue;
        placed.push(box);
        labels.append("text").attr("class", `label halo${d.cik === st.selected ? " strong" : ""}`).attr("x", lx).attr("y", cy(d))
          .attr("dy", "0.32em").text(d.ticker);
      }
      const delaunay = Delaunay.from(pts, cx, cy);
      const near = (ev: PointerEvent) => {
        const [mx, my] = pointer(ev);
        const d = pts[delaunay.find(mx, my)];
        return d && Math.hypot(cx(d) - mx, cy(d) - my) <= Math.max(18, r(d.value ?? 0) + 6) ? d : null;
      };
      f.g.append("rect").attr("class", "hit").attr("width", f.width).attr("height", f.height).style("cursor", "pointer")
        .on("pointermove", (ev: PointerEvent) => {
          const d = near(ev);
          if (!d) { hideTip(); o.store.set({ hover: null }); return; }
          o.store.set({ hover: d.cik });
          const tip = dealTip(d);
          showTip(ev.clientX, ev.clientY, `${d.target} (${d.ticker})`, tip.rows, tip.note);
        })
        .on("pointerleave", () => { hideTip(); o.store.set({ hover: null }); })
        .on("click", (ev: PointerEvent) => {
          const d = near(ev);
          if (d && o.canFocus(d.cik)) o.store.set({ selected: d.cik });
        });
      const unsub = o.store.on(["hover"], (s2) => {
        if (!f.svg.node()?.isConnected) { unsub(); return; }
        dots.style("fill-opacity", (d) => (s2.hover == null || d.cik === s2.hover || d.cik === s2.selected ? 0.85 : 0.3));
      });
    });
  };
  o.card.onRedraw(draw);
  draw();
  return { redraw: draw };
}
